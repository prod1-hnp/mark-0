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
const PRINTER_NAME = process.env.PRINTER_NAME || `Printer-${os.hostname()}`;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function isTargetPrinter(requestedName) {
    if (!requestedName || requestedName === 'Test-Printer' || requestedName === 'all') return true;
    if (requestedName === PRINTER_NAME) return true;

    const normReq = requestedName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normMy = PRINTER_NAME.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normReq === normMy) return true;
    if (normMy.includes(normReq) || normReq.includes(normMy)) return true;

    // HP matching: if both target an HP laser printer
    if ((normReq.includes('hp') || normReq.includes('laserjet')) &&
        (normMy.includes('hp') || normMy.includes('laserjet'))) {
        return true;
    }

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

        const ext = path.extname(originalFilename) || '.pdf';
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

async function printFile(filePath, copies = 1, isColor = false, isDuplex = false) {
    try {
        console.log(`Printing file: ${filePath}`);
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
                    await new Promise((resolve) => {
                        exec(`powershell.exe -Command "Get-Content -Path '${actualFileToPrint}' | Out-Printer"`, () => resolve());
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
                    printer: PRINTER_NAME !== 'Test-Printer' ? PRINTER_NAME : undefined,
                    monochrome: !isColor,
                    ...(isDuplex && { side: duplexSide })
                };
                try {
                    await print(actualFileToPrint, printOptions); // use pdf-to-printer
                } catch (pdfErr) {
                    console.warn(`pdf-to-printer error (${pdfErr.message}), trying Windows native print...`);
                    if (os.type() === 'Windows_NT') {
                        const targetPrinter = PRINTER_NAME !== 'Test-Printer' ? PRINTER_NAME : '';
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
                    const psCommand = `Start-Process -FilePath "${actualFileToPrint}" -Verb Print -PassThru | ForEach-Object { Start-Sleep -Seconds 5; $_ } | Stop-Process -Force -ErrorAction SilentlyContinue`;
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

    socket.on('connect', () => {
        log(`✓ Connected to server: ${SERVER_URL}`, 'SUCCESS');
        socket.emit('printer-registered', {
            printerName: PRINTER_NAME,
            platform: os.type(),
            hostname: os.hostname()
        });
        log(`Printer registered: ${PRINTER_NAME}`, 'SUCCESS');
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
        const isColor = data.color || false;
        const isDuplex = data.duplex || false;

        log('═'.repeat(60));
        log('📄 New print job received!', 'INFO');
        log(`   Job ID: ${jobId}`);
        log(`   Printer: ${printerName}`);
        log(`   File: ${filename}`);
        log(`   Pages: ${pageCount}`);
        log(`   Copies: ${copies}`);
        log(`   Color: ${isColor ? 'Yes' : 'No'}`);
        log(`   Duplex: ${isDuplex ? '2-sided' : '1-sided'}`);
        log('═'.repeat(60));

        if (!isTargetPrinter(printerName)) {
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
        const success = await printFile(filepath, copies, isColor, isDuplex);

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

async function main() {
    console.log('\n');
    console.log('╔════════════════════════════════════════╗');
    console.log('║      Cloud Printer Agent Started      ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  Server: ${SERVER_URL.padEnd(28)} ║`);
    console.log(`║  Printer: ${PRINTER_NAME.padEnd(27)} ║`);
    console.log(`║  Platform: ${os.type().padEnd(26)} ║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('\n');

    log('Connecting to server...');
    const socket = createSocket();

    process.on('SIGINT', async () => {
        log('Shutting down agent...', 'WARNING');
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
