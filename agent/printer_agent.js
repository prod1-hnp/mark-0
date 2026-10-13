const { io } = require('socket.io-client');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, exec } = require('child_process');
require('dotenv').config();
const { print } = require("pdf-to-printer");
const { PDFDocument } = require('pdf-lib');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');
const SCAN_INTERVAL_MS = 60_000; // Re-scan printers every 60 seconds

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// ═══════════════════════════════════════════════════════
// Printer Auto-Discovery — Cross-platform
// ═══════════════════════════════════════════════════════

let discoveredPrinters = [];   // Cache of discovered printers
let activePrinterName = null;  // The printer this agent is using

/**
 * Discover all installed printers on the system.
 * Uses OS-native commands:
 *   Windows  → PowerShell Get-Printer
 *   macOS    → lpstat -a  +  lpstat -p
 *   Linux    → lpstat -a  +  lpstat -p
 * Returns array of { name, driver, port, status, isDefault }
 */
async function discoverPrinters() {
    const platform = os.type();
    try {
        if (platform === 'Windows_NT') {
            return await discoverWindowsPrinters();
        } else {
            return await discoverUnixPrinters();
        }
    } catch (err) {
        log(`Printer discovery failed: ${err.message}`, 'ERROR');
        return [];
    }
}

/**
 * Windows: Uses PowerShell Get-Printer to list all printers with details
 */
function discoverWindowsPrinters() {
    return new Promise((resolve) => {
        const psCommand = 'Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default, DriverName, PortName, PrinterStatus | ConvertTo-Json -Compress';

        exec(`powershell.exe -NoProfile -Command "${psCommand}"`, { timeout: 15000 }, (error, stdout) => {
            if (error) {
                log(`PowerShell Get-CimInstance error: ${error.message}, trying fallback`, 'WARN');
                return discoverWindowsPrintersWmic().then(resolve).catch(() => resolve([]));
            }
            try {
                const trimmed = stdout.trim();
                if (!trimmed) return resolve([]);
                let parsed = JSON.parse(trimmed);
                // PowerShell returns a single object (not array) when only 1 printer
                if (!Array.isArray(parsed)) parsed = [parsed];

                const printers = parsed.map(p => ({
                    name: p.Name || 'Unknown',
                    driver: p.DriverName || 'Unknown',
                    port: p.PortName || '',
                    status: normalizeStatus(p.PrinterStatus),
                    isDefault: p.Default === true || p.Default === 'true'
                }));
                resolve(printers);
            } catch (parseErr) {
                log(`Failed to parse printer list: ${parseErr.message}`, 'WARN');
                resolve([]);
            }
        });
    });
}

/**
 * Windows fallback: Uses wmic if PowerShell Get-Printer is unavailable
 */
function discoverWindowsPrintersWmic() {
    return new Promise((resolve, reject) => {
        exec('wmic printer get Name,DriverName,PortName,Default,Status /format:csv', { timeout: 15000 }, (error, stdout) => {
            if (error) return reject(error);
            try {
                const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.startsWith('Node'));
                const printers = lines.map(line => {
                    const parts = line.trim().split(',');
                    // CSV: Node, Default, DriverName, Name, PortName, Status
                    if (parts.length >= 6) {
                        return {
                            name: parts[3] || 'Unknown',
                            driver: parts[2] || 'Unknown',
                            port: parts[4] || '',
                            status: normalizeStatus(parts[5]),
                            isDefault: parts[1]?.toUpperCase() === 'TRUE'
                        };
                    }
                    return null;
                }).filter(Boolean);
                resolve(printers);
            } catch (e) {
                resolve([]);
            }
        });
    });
}

/**
 * macOS / Linux: Uses lpstat to enumerate printers
 */
function discoverUnixPrinters() {
    return new Promise((resolve, reject) => {
        // Get list of printers and default printer in parallel
        exec('lpstat -a 2>/dev/null && echo "===SEPARATOR===" && lpstat -d 2>/dev/null', { timeout: 10000 }, (error, stdout) => {
            if (error) return reject(error);
            try {
                const [printerSection, defaultSection] = stdout.split('===SEPARATOR===');
                
                // Parse default printer
                let defaultPrinter = '';
                if (defaultSection) {
                    const match = defaultSection.match(/system default destination:\s*(\S+)/i);
                    if (match) defaultPrinter = match[1];
                }

                // Parse printer list
                const printers = [];
                if (printerSection) {
                    const lines = printerSection.trim().split('\n');
                    for (const line of lines) {
                        // Format: "PrinterName accepting requests since ..."
                        const match = line.match(/^(\S+)\s+accepting/);
                        if (match) {
                            printers.push({
                                name: match[1],
                                driver: 'System Driver',
                                port: '',
                                status: 'ready',
                                isDefault: match[1] === defaultPrinter
                            });
                        }
                    }
                }
                resolve(printers);
            } catch (e) {
                resolve([]);
            }
        });
    });
}

/**
 * Normalize printer status string to a consistent value
 */
function normalizeStatus(raw) {
    if (raw === undefined || raw === null) return 'ready';
    const s = raw.toString().toLowerCase().trim();
    // In Win32_Printer: 3 = Idle/Ready, 4 = Printing/Busy, 5 = Warmup, 7 = Offline
    if (s === '0' || s === 'normal' || s === 'idle' || s === 'ready' || s === 'ok' || s === '3') return 'ready';
    if (s.includes('offline') || s === '7') return 'offline';
    if (s.includes('error') || s.includes('fault')) return 'error';
    if (s.includes('busy') || s.includes('printing') || s === '4' || s === '1') return 'busy';
    if (s.includes('paused')) return 'paused';
    if (s.includes('paper') || s.includes('jam')) return 'paper_issue';
    if (s.includes('toner') || s.includes('ink')) return 'low_ink';
    return s || 'ready';
}

/**
 * Select the active printer:
 *  1. If PRINTER_NAME is set in .env and exists in discovered list → use it
 *  2. If PRINTER_NAME is set but NOT in list → still use it (user knows best)
 *  3. If not set → use system default printer
 *  4. If no default → use first available printer
 *  5. If nothing found → fallback to hostname-based name
 */
function selectActivePrinter(printers) {
    const envPrinterName = process.env.PRINTER_NAME;

    if (envPrinterName) {
        // User explicitly set a printer in .env
        const found = printers.find(p => p.name === envPrinterName);
        if (found) {
            log(`Using configured printer: ${envPrinterName} (found in system)`, 'SUCCESS');
        } else if (printers.length > 0) {
            log(`Configured printer "${envPrinterName}" not found in system, using it anyway`, 'WARN');
        }
        return envPrinterName;
    }

    // Auto-select: prefer default, then first ready, then first available
    const defaultPrinter = printers.find(p => p.isDefault);
    if (defaultPrinter) {
        log(`Auto-selected default printer: ${defaultPrinter.name}`, 'SUCCESS');
        return defaultPrinter.name;
    }

    const readyPrinter = printers.find(p => p.status === 'ready');
    if (readyPrinter) {
        log(`Auto-selected ready printer: ${readyPrinter.name}`, 'SUCCESS');
        return readyPrinter.name;
    }

    if (printers.length > 0) {
        log(`Auto-selected first available printer: ${printers[0].name}`, 'SUCCESS');
        return printers[0].name;
    }

    const fallback = `Printer-${os.hostname()}`;
    log(`No printers found, using fallback: ${fallback}`, 'WARN');
    return fallback;
}

function isTargetPrinter(requestedName, myName) {
    const printerName = myName || activePrinterName;
    if (!requestedName || requestedName === 'Test-Printer' || requestedName === 'all') return true;
    if (requestedName === printerName) return true;

    const normReq = requestedName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normMy = printerName.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normReq === normMy) return true;
    if (normMy.includes(normReq) || normReq.includes(normMy)) return true;

    // HP matching: if both target an HP laser printer
    if ((normReq.includes('hp') || normReq.includes('laserjet')) &&
        (normMy.includes('hp') || normMy.includes('laserjet'))) {
        return true;
    }

    // Check if requested printer exists in discovered list
    if (discoveredPrinters.some(p => p.name === requestedName)) return true;

    return false;
}

function log(message, level = 'INFO') {
    const ts = new Date().toISOString().replace('T', ' ').substr(0, 19);
    console.log(`[${ts}] [${level}] ${message}`);
}

async function downloadFile(fileUrl, jobId, originalFilename) {
    try {
        const fullUrl = fileUrl.startsWith('/') ? `${SERVER_URL}${fileUrl}` : fileUrl;
        log(`Downloading file from: ${fullUrl}`);

        const ext = path.extname(fileUrl) || path.extname(originalFilename) || '.pdf';
        const filepath = path.join(DOWNLOAD_DIR, `${jobId}${ext}`);
        const writer = fs.createWriteStream(filepath);

        const response = await axios({ url: fullUrl, method: 'GET', responseType: 'stream', timeout: 30_000 });
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            let error = null;
            writer.on('error', err => {
                error = err;
                writer.close();
                reject(err);
            });
            writer.on('close', () => {
                if (!error) resolve();
            });
        });

        log(`File downloaded successfully: ${filepath}`);
        return filepath;
    } catch (err) {
        log(`Failed to download file: ${err.message}`, 'ERROR');
        return null;
    }
}

async function convertImageToPdf(imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    const pdfPath = imagePath + '.pdf';
    try {
        const imageBytes = fs.readFileSync(imagePath);
        const pdfDoc = await PDFDocument.create();
        let image;
        if (ext === '.png') {
            image = await pdfDoc.embedPng(imageBytes);
        } else if (ext === '.jpg' || ext === '.jpeg') {
            image = await pdfDoc.embedJpg(imageBytes);
        } else {
            return imagePath;
        }

        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();

        const scale = Math.min(width / image.width, height / image.height);
        const scaledWidth = image.width * scale;
        const scaledHeight = image.height * scale;

        page.drawImage(image, {
            x: (width / 2) - (scaledWidth / 2),
            y: (height / 2) - (scaledHeight / 2),
            width: scaledWidth,
            height: scaledHeight,
        });

        const pdfBytes = await pdfDoc.save();
        fs.writeFileSync(pdfPath, pdfBytes);
        return pdfPath;
    } catch (e) {
        console.error("Error converting image to PDF:", e);
        return imagePath;
    }
}

async function printFile(filePath, copies = 1, isColor = false, isDuplex = false, targetPrinterName = activePrinterName) {
    try {
        const chosenPrinter = (targetPrinterName && targetPrinterName !== 'Test-Printer' && targetPrinterName !== 'all')
            ? targetPrinterName
            : (activePrinterName !== 'Test-Printer' ? activePrinterName : undefined);

        console.log(`Printing file: ${filePath}`);
        console.log(`Target printer: ${chosenPrinter || 'Default System Printer'}`);
        console.log(`Number of copies: ${copies}`);
        console.log(`Color mode: ${isColor ? 'Color' : 'Black & White'}`);
        console.log(`Duplex: ${isDuplex ? '2-sided' : '1-sided'}`);

        let actualFileToPrint = filePath;
        const ext = path.extname(filePath).toLowerCase();

        if (['.png', '.jpg', '.jpeg'].includes(ext)) {
            console.log('Converting image to PDF for reliable printing...');
            actualFileToPrint = await convertImageToPdf(filePath);
        }

        const newExt = path.extname(actualFileToPrint).toLowerCase();

        for (let i = 1; i <= copies; i++) {
            console.log(`Printing copy ${i} of ${copies}...`);
            if (newExt === '.txt') {
                if (os.type() === 'Windows_NT') {
                    const printerArg = chosenPrinter ? `-Name "${chosenPrinter}"` : '';
                    await new Promise((resolve) => {
                        exec(`powershell.exe -Command "Get-Content -Path '${actualFileToPrint}' | Out-Printer ${printerArg}"`, () => resolve());
                    });
                } else {
                    await new Promise((resolve, reject) => {
                        exec(`lpr "${actualFileToPrint}"`, (error) => {
                            if (error) reject(error);
                            else resolve();
                        });
                    });
                }
            } else if (newExt === '.pdf') {
                // Detect orientation to pick correct duplex edge
                let duplexSide = 'duplexlong'; // default for portrait
                if (isDuplex) {
                    try {
                        const fileBytes = fs.readFileSync(actualFileToPrint);
                        const pdfDoc = await PDFDocument.load(fileBytes);
                        const pages = pdfDoc.getPages();
                        if (pages.length > 0) {
                            const firstPage = pages[0];
                            const { width, height } = firstPage.getSize();
                            const rotation = (firstPage.getRotation()?.angle || 0) % 360;
                            const isLandscape = (rotation === 90 || rotation === 270)
                                ? (height > width)
                                : (width > height);
                            // Landscape → flip on short edge; Portrait → flip on long edge
                            duplexSide = isLandscape ? 'duplexshort' : 'duplexlong';
                            console.log(`Detected orientation: ${isLandscape ? 'Landscape' : 'Portrait'} → duplex: ${duplexSide}`);
                        }
                    } catch (e) {
                        console.warn('Could not detect PDF orientation, defaulting to duplexlong:', e.message);
                    }
                }

                const printOptions = {
                    printer: chosenPrinter,
                    monochrome: !isColor,
                    ...(isDuplex && { side: duplexSide })
                };
                try {
                    await print(actualFileToPrint, printOptions); // use pdf-to-printer
                } catch (pdfErr) {
                    console.warn(`pdf-to-printer error (${pdfErr.message}), trying Windows native print...`);
                    if (os.type() === 'Windows_NT') {
                        const targetPrinter = chosenPrinter || '';
                        const psCommand = targetPrinter
                            ? `Start-Process -FilePath "${actualFileToPrint}" -Verb PrintTo -ArgumentList '"${targetPrinter}"' -PassThru | ForEach-Object { Start-Sleep -Seconds 5; $_ } | Stop-Process -Force -ErrorAction SilentlyContinue`
                            : `Start-Process -FilePath "${actualFileToPrint}" -Verb Print -PassThru | ForEach-Object { Start-Sleep -Seconds 5; $_ } | Stop-Process -Force -ErrorAction SilentlyContinue`;
                        await new Promise((resolve) => {
                            exec(`powershell.exe -Command "${psCommand}"`, () => resolve());
                        });
                    } else {
                        throw pdfErr;
                    }
                }
            } else {
                if (os.type() === 'Windows_NT') {
                    // Fallback for unsupported formats
                    const targetPrinter = chosenPrinter || '';
                    const psCommand = targetPrinter
                        ? `Start-Process -FilePath "${actualFileToPrint}" -Verb PrintTo -ArgumentList '"${targetPrinter}"' -PassThru | ForEach-Object { Start-Sleep -Seconds 5; $_ } | Stop-Process -Force -ErrorAction SilentlyContinue`
                        : `Start-Process -FilePath "${actualFileToPrint}" -Verb Print -PassThru | ForEach-Object { Start-Sleep -Seconds 5; $_ } | Stop-Process -Force -ErrorAction SilentlyContinue`;
                    await new Promise((resolve) => {
                        exec(`powershell.exe -Command "${psCommand}"`, () => resolve());
                    });
                } else {
                    await new Promise((resolve, reject) => {
                        exec(`lpr "${actualFileToPrint}"`, (error) => {
                            if (error) reject(error);
                            else resolve();
                        });
                    });
                }
            }
        }

        console.log(`✓ Print job sent successfully (${copies} ${copies === 1 ? 'copy' : 'copies'})`);
        return true;
    } catch (error) {
        console.error("Printing failed:", error.message);
        return false;
    }
}

function createSocket() {
    // connect socket
    const socket = io(`${SERVER_URL}/connectprinter`, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        transports: ['websocket'],
    });

    socket.on('connect', async () => {
        log(`✓ Connected to server: ${SERVER_URL}`, 'SUCCESS');

        // Discover printers on connect
        await runPrinterDiscovery();

        // Register with active printer name
        socket.emit('printer-registered', {
            printerName: activePrinterName,
            platform: os.type(),
            hostname: os.hostname(),
            discoveredPrinters: discoveredPrinters
        });
        log(`Printer registered: ${activePrinterName}`, 'SUCCESS');

        // Handle server requesting a re-scan
        socket.on('request-printer-scan', async () => {
            log('Server requested printer re-scan', 'INFO');
            await runPrinterDiscovery();
            socket.emit('printer-list-update', {
                printerName: activePrinterName,
                discoveredPrinters: discoveredPrinters
            });
        });
    });

    socket.on('disconnect', (reason) => {
        log(`Disconnected from server (${reason})`, 'WARNING');
    });

    socket.on('connect_error', (err) => {
        log(`Connection error: ${err && err.message ? err.message : err}`, 'ERROR');
    });

    socket.on('new-print-job', async (data) => {
        const jobId = data.jobId;
        const printerName = data.printerName;
        const fileUrl = data.fileUrl;
        const filename = data.filename;
        const copies = data.copies || 1;
        const pageCount = data.pageCount || 0;
        const pageRange = data.pageRange || 'all';
        const isColor = data.color || false;
        const isDuplex = data.duplex || false;

        log('═'.repeat(60));
        log('📄 New print job received!', 'INFO');
        log(`   Job ID: ${jobId}`);
        log(`   Printer: ${printerName}`);
        log(`   File: ${filename}`);
        log(`   Pages: ${pageCount}${pageRange !== 'all' ? ` (Range: ${pageRange})` : ''}`);
        log(`   Copies: ${copies}`);
        log(`   Color: ${isColor ? 'Yes' : 'No'}`);
        log(`   Duplex: ${isDuplex ? '2-sided' : '1-sided'}`);
        log('═'.repeat(60));

        if (!isTargetPrinter(printerName, activePrinterName)) {
            log(`Job is for different printer (${printerName}), ignoring`, 'INFO');
            return;
        }

        // Update status to processing
        socket.emit('job-status-update', { jobId, status: 'processing' });

        // Download
        const filepath = await downloadFile(fileUrl, jobId, filename);
        if (!filepath) {
            socket.emit('job-status-update', { jobId, status: 'failed' });
            return;
        }

        // Print with copies
        const success = await printFile(filepath, copies, isColor, isDuplex, printerName);

        // Update final status
        if (success) {
            socket.emit('job-status-update', { jobId, status: 'completed' });
            log(`✓ Print job completed successfully! (${copies} ${copies === 1 ? 'copy' : 'copies'})`, 'SUCCESS');
        } else {
            socket.emit('job-status-update', { jobId, status: 'failed' });
            log('✗ Print job failed', 'ERROR');
        }

        log('═'.repeat(60));
    });

    return socket;
}

/**
 * Run printer discovery and update state
 */
async function runPrinterDiscovery() {
    log('Scanning for installed printers...', 'INFO');
    discoveredPrinters = await discoverPrinters();

    if (discoveredPrinters.length === 0) {
        log('No printers found on this system', 'WARN');
    } else {
        log(`Found ${discoveredPrinters.length} printer(s):`, 'SUCCESS');
        discoveredPrinters.forEach((p, i) => {
            const defaultTag = p.isDefault ? ' ★ DEFAULT' : '';
            log(`  ${i + 1}. ${p.name} [${p.status}] (${p.driver})${defaultTag}`);
        });
    }

    // Select active printer
    activePrinterName = selectActivePrinter(discoveredPrinters);
}

async function main() {
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║         Cloud Printer Agent Started               ║');
    console.log('╠════════════════════════════════════════════════════╣');
    console.log(`║  Server:   ${SERVER_URL.padEnd(38)} ║`);
    console.log(`║  Platform: ${os.type().padEnd(38)} ║`);
    console.log('╠════════════════════════════════════════════════════╣');
    console.log('║  Scanning for installed printers...               ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('\n');

    // Initial printer discovery
    await runPrinterDiscovery();

    console.log('\n');
    console.log(`  ➜ Active Printer: ${activePrinterName}`);
    console.log(`  ➜ Total Detected: ${discoveredPrinters.length}`);
    console.log('\n');

    log('Connecting to server...');
    const socket = createSocket();

    // Periodic re-scan for new/removed printers
    const scanInterval = setInterval(async () => {
        const oldCount = discoveredPrinters.length;
        const oldNames = discoveredPrinters.map(p => p.name).sort().join(',');

        await runPrinterDiscovery();

        const newNames = discoveredPrinters.map(p => p.name).sort().join(',');

        // Only notify server if printer list changed
        if (oldNames !== newNames) {
            log(`Printer list changed (${oldCount} → ${discoveredPrinters.length}), notifying server`, 'INFO');
            if (socket.connected) {
                socket.emit('printer-list-update', {
                    printerName: activePrinterName,
                    discoveredPrinters: discoveredPrinters
                });
            }
        }
    }, SCAN_INTERVAL_MS);

    process.on('SIGINT', async () => {
        log('Shutting down agent...', 'WARNING');
        clearInterval(scanInterval);
        try {
            socket.disconnect();
        } catch (err) {
            // ignore
        }
        log('Agent stopped', 'INFO');
        process.exit(0);
    });
}

if (require.main === module) {
    main().catch(err => {
        log(`Fatal error: ${err && err.message ? err.message : err}`, 'ERROR');
        process.exit(1);
    });
}
