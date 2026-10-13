import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import pdfParse from 'pdf-parse';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import sharp from 'sharp';
import PrintJob from './models/PrintJob.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// CORS configuration
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3000'];

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  }
});
const printerIO = io.of('/connectprinter');

// API Key for sensitive endpoints
const API_KEY = process.env.API_KEY || '';

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // Skip auth if no API key configured
  const providedKey = req.headers['x-api-key'] || req.query.api_key;
  if (providedKey === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
}

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// DB Connection
const MONGODB_URI = process.env.DB_URL;
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Test mode configuration (allows printing without payment for testing)
const TEST_MODE = process.env.TEST_MODE === 'true' || 
  !process.env.RAZORPAY_KEY_ID || 
  process.env.RAZORPAY_KEY_ID.includes('<') || 
  process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_dummy');

if (TEST_MODE) {
  console.log('🧪 TEST MODE ACTIVE: Printing without payment enabled');
}

// Connected printer agents tracking
const connectedPrinters = new Map();

function isPrinterMatch(targetName, registeredName) {
  if (!targetName || targetName === 'Test-Printer' || targetName === 'all') return true;
  if (targetName === registeredName) return true;

  const normTarget = targetName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normReg = registeredName.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (normTarget === normReg) return true;
  if (normReg.includes(normTarget) || normTarget.includes(normReg)) return true;

  if ((normTarget.includes('hp') || normTarget.includes('laserjet')) && 
      (normReg.includes('hp') || normReg.includes('laserjet'))) {
    return true;
  }
  return false;
}

// Helper: find sockets for a specific printer name
function getSocketsForPrinter(printerName) {
  const sockets = [];
  for (const [socketId, printerInfo] of connectedPrinters) {
    if (isPrinterMatch(printerName, printerInfo.printerName)) {
      const socket = printerIO.sockets?.get(socketId);
      if (socket) sockets.push(socket);
    }
  }
  // Fallback: If no direct match and only 1 printer agent connected, route to it
  if (sockets.length === 0 && connectedPrinters.size === 1) {
    const onlySocketId = connectedPrinters.keys().next().value;
    const socket = printerIO.sockets?.get(onlySocketId);
    if (socket) sockets.push(socket);
  }
  return sockets;
}

// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret'
});

// Upload file
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const fileFilter = (req, file, cb) => {
  // Allow all files
  cb(null, true);
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});


app.get('/', (req, res) => {
  res.render('index', { testMode: TEST_MODE });
});

// Config API
app.get('/api/config', (req, res) => {
  res.json({
    testMode: TEST_MODE,
    razorpayKey: (process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.includes('<')) 
      ? process.env.RAZORPAY_KEY_ID 
      : 'rzp_test_dummy_key'
  });
});

// Connected printers API
app.get('/api/printers', (req, res) => {
  const printers = Array.from(new Set(Array.from(connectedPrinters.values()).map(p => p.printerName)));
  res.json({
    printers: printers,
    count: printers.length
  });
});

// Detect if an image file contains color or is grayscale
async function detectImageColor(filePath) {
  try {
    const { data, info } = await sharp(filePath)
      .resize(100, 100, { fit: 'inside' }) // downsize for speed
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    if (channels === 1 || channels === 2) return false; // Grayscale (+ optional alpha)

    const pixels = info.width * info.height;
    let colorPixels = 0;
    const threshold = 20; // tolerance for channel difference

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.abs(r - g) > threshold || Math.abs(g - b) > threshold || Math.abs(r - b) > threshold) {
        colorPixels++;
      }
    }

    // If more than 3% of pixels have distinct color, it's a color image
    return (colorPixels / pixels) > 0.03;
  } catch (err) {
    console.warn('Color detection failed, defaulting to color:', err.message);
    return true; // Assume color if detection fails
  }
}

// Process image for B&W printing — removes gray backgrounds to save toner
// Converts light grays to pure white, keeps dark text/content as black
async function processImageForBW(uploadedFilePath) {
  const ext = path.extname(uploadedFilePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'].includes(ext)) {
    return null; // Not a processable image (e.g. PDF, txt)
  }

  const dir = path.dirname(uploadedFilePath);
  const baseName = path.basename(uploadedFilePath, ext);
  const outputPath = path.join(dir, `${baseName}_bw${ext}`);

  try {
    await sharp(uploadedFilePath)
      .grayscale()
      .normalize()         // Stretch contrast to full range
      .threshold(170)      // Brightness > 170 → white, ≤ 170 → black
      .toFile(outputPath);

    console.log(`✓ B&W processed: ${path.basename(outputPath)} (gray background → white)`);
    return outputPath;
  } catch (err) {
    console.warn('B&W image processing failed, using original:', err.message);
    return null;
  }
}

// Step 1: upload the files and count pages (if PDF)
app.post('/upload', upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const filesInfo = [];

    for (const file of req.files) {
      let pageCount = 1;
      let isColorDocument = null; // null = unknown (e.g. PDF), true/false for images

      if (file.mimetype === 'application/pdf') {
        try {
          const dataBuffer = fs.readFileSync(file.path);
          const pdfData = await pdfParse(dataBuffer);
          pageCount = pdfData.numpages;
        } catch (err) {
          console.warn('Failed to parse PDF pages, defaulting to 1:', err.message);
        }
      } else if (file.mimetype && file.mimetype.startsWith('image/')) {
        // Detect if image is color or grayscale
        isColorDocument = await detectImageColor(file.path);
        console.log(`Color detection for ${file.originalname}: ${isColorDocument ? 'COLOR' : 'GRAYSCALE'}`);
      }

      console.log(`File uploaded: ${file.originalname}`);
      console.log(`Total pages: ${pageCount}`);

      filesInfo.push({
        fileId: file.filename,
        originalName: file.originalname,
        pageCount: pageCount,
        isColorDocument: isColorDocument
      });
    }

    res.json({
      success: true,
      message: 'Files uploaded successfully',
      files: filesInfo
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Failed to upload file',
      details: error.message 
    });
  }
});

// Step 2: Create Razorpay order or dispatch autonomous print
app.post('/checkout-batch', async (req, res) => {
  try {
    const { items, printerName, autoPrint } = req.body;

    if (!items || !items.length || !printerName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const batchId = `batch_${Date.now()}`;
    let totalAmountInRupees = 0;

    for (const item of items) {
      const pricePerPage = item.color ? 5 : 2;
      totalAmountInRupees += (item.pageCount * pricePerPage) * item.copies;
    }

    if (autoPrint === 'true') {
      for (const item of items) {
        const pricePerPage = item.color ? 5 : 2;
        const amount = (item.pageCount * pricePerPage) * item.copies;

        // If B&W selected, process image to remove gray backgrounds
        let filePath = `uploads/${item.fileId}`;
        let fileUrl = `/uploads/${item.fileId}`;
        if (!item.color) {
          const processed = await processImageForBW(path.join(__dirname, filePath));
          if (processed) {
            const processedRelative = path.relative(__dirname, processed).replace(/\\/g, '/');
            filePath = processedRelative;
            fileUrl = '/' + processedRelative;
          }
        }
        
        const printJob = new PrintJob({
          filename: item.fileId,
          originalName: item.originalName,
          filePath: filePath,
          fileUrl: fileUrl,
          printerName: printerName,
          pageCount: item.pageCount,
          copies: item.copies,
          color: item.color,
          duplex: item.duplex || false,
          batchId: batchId,
          amount: amount,
          razorpayOrderId: `auto_order_${batchId}`,
          paymentId: `auto_free_${batchId}`,
          paymentStatus: 'paid',
          status: 'pending'
        });
        await printJob.save();

        const targetSockets = getSocketsForPrinter(printJob.printerName);
        const jobData = {
          jobId: printJob._id,
          printerName: printJob.printerName,
          fileUrl: printJob.fileUrl,
          filename: printJob.originalName,
          filePath: path.join(__dirname, printJob.filePath),
          copies: printJob.copies,
          color: printJob.color,
          duplex: printJob.duplex,
          pageCount: printJob.pageCount
        };
        if (targetSockets.length > 0) {
          targetSockets.forEach(s => s.emit('new-print-job', jobData));
        } else {
          console.warn(`⚠ No connected agent found for printer: ${printJob.printerName}`);
        }
        console.log(`✓ Job dispatched for file ${item.originalName} (${item.copies} copies, color: ${item.color})`);
      }

      return res.json({
        success: true,
        message: 'Jobs dispatched automatically',
        testMode: true,
        batchId,
        amount: totalAmountInRupees
      });
    }

    // Razorpay Flow
    const amountInPaise = totalAmountInRupees * 100;
    const options = {
      amount: amountInPaise,
      currency: 'INR',
      receipt: batchId
    };

    let order;
    try {
      order = await razorpay.orders.create(options);
    } catch (err) {
      console.warn('Razorpay order creation failed, falling back:', err.message);
      order = { id: `order_test_${Date.now()}` };
    }

    for (const item of items) {
      const pricePerPage = item.color ? 5 : 2;
      const amount = (item.pageCount * pricePerPage) * item.copies;

      // If B&W selected, process image to remove gray backgrounds
      let filePath = `uploads/${item.fileId}`;
      let fileUrl = `/uploads/${item.fileId}`;
      if (!item.color) {
        const processed = await processImageForBW(path.join(__dirname, filePath));
        if (processed) {
          const processedRelative = path.relative(__dirname, processed).replace(/\\/g, '/');
          filePath = processedRelative;
          fileUrl = '/' + processedRelative;
        }
      }

      const printJob = new PrintJob({
        filename: item.fileId,
        originalName: item.originalName,
        filePath: filePath,
        fileUrl: fileUrl,
        printerName: printerName,
        pageCount: item.pageCount,
        copies: item.copies,
        color: item.color,
        duplex: item.duplex || false,
        batchId: batchId,
        amount: amount,
        razorpayOrderId: order.id,
        paymentStatus: 'pending',
        status: 'pending'
      });
      await printJob.save();
    }

    res.json({
      success: true,
      orderId: order.id,
      batchId: batchId,
      amount: totalAmountInRupees,
      currency: 'INR',
      key: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key',
      testMode: TEST_MODE
    });

  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// Step 3: Verify payment and trigger print (with fallback for test mode)
app.post('/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, batchId } = req.body;

    const isMockPayment = TEST_MODE || 
      (razorpay_payment_id && razorpay_payment_id.startsWith('pay_test_')) || 
      (razorpay_order_id && razorpay_order_id.startsWith('order_test_')) || 
      razorpay_signature === 'test_signature';

    if (!isMockPayment) {
      // Verify signature
      const generatedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'dummy_secret')
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid payment signature' 
        });
      }
    }

    // Update print jobs with payment info
    await PrintJob.updateMany(
      { batchId: batchId },
      { 
        paymentId: razorpay_payment_id || `pay_test_${Date.now()}`,
        paymentStatus: 'paid',
        updatedAt: new Date()
      }
    );

    const jobs = await PrintJob.find({ batchId: batchId });

    if (!jobs || jobs.length === 0) {
      return res.status(404).json({ error: 'Print jobs not found for this batch' });
    }

    // emit message to socket to printer with copies and color for each
    for (const printJob of jobs) {
      const targetSockets = getSocketsForPrinter(printJob.printerName);
      const jobData = {
        jobId: printJob._id,
        printerName: printJob.printerName,
        fileUrl: printJob.fileUrl,
        filename: printJob.originalName,
        filePath: path.join(__dirname, printJob.filePath),
        copies: printJob.copies,
        color: printJob.color,
        duplex: printJob.duplex,
        pageCount: printJob.pageCount
      };
      if (targetSockets.length > 0) {
        targetSockets.forEach(s => s.emit('new-print-job', jobData));
      } else {
        console.warn(`⚠ No connected agent found for printer: ${printJob.printerName}`);
      }
      console.log(`✓ Print job verified & sent for job ${printJob._id}`);
    }

    res.json({
      success: true,
      message: 'Print jobs confirmed and sent to printer',
      batchId: batchId
    });

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ 
      error: 'Failed to verify payment',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  const printers = Array.from(new Set(Array.from(connectedPrinters.values()).map(p => p.printerName)));
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    connectedPrinters: printers.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/jobs', requireApiKey, async (req, res) => {
  try {
    const jobs = await PrintJob.find().sort({ uploadedAt: -1 }).limit(50);
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// update status (protected by API key)
app.put('/api/jobs/:id/status', requireApiKey, async (req, res) => {
  try {
    const { status } = req.body;
    const job = await PrintJob.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: new Date() },
      { new: true }
    );
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update job status' });
  }
});


// socket connection
printerIO.on('connection', (socket) => {
  console.log('✓ Printer agent connected:', socket.id);

  socket.on('printer-registered', async (data) => {
    console.log(`✓ Printer registered: ${data.printerName}`);
    if (data && data.printerName) {
      connectedPrinters.set(socket.id, {
        printerName: data.printerName,
        platform: data.platform || 'unknown',
        hostname: data.hostname || 'unknown',
        connectedAt: new Date()
      });

      // Pending Jobs Recovery Logic
      try {
        const allPendingJobs = await PrintJob.find({
          status: 'pending',
          paymentStatus: 'paid',
          createdAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) }
        });

        const pendingJobs = allPendingJobs.filter(job =>
          isPrinterMatch(job.printerName, data.printerName) || connectedPrinters.size === 1
        );

        if (pendingJobs.length > 0) {
          console.log(`Found ${pendingJobs.length} pending jobs for ${data.printerName}. Dispatching them now...`);
          for (const printJob of pendingJobs) {
            socket.emit('new-print-job', {
              jobId: printJob._id,
              printerName: printJob.printerName,
              fileUrl: printJob.fileUrl,
              filename: printJob.originalName,
              filePath: path.join(__dirname, printJob.filePath),
              copies: printJob.copies,
              color: printJob.color,
              duplex: printJob.duplex,
              pageCount: printJob.pageCount
            });
            console.log(`✓ Pending print job sent for job ${printJob._id}`);
          }
        }
      } catch (err) {
        console.error('Error recovering pending jobs:', err);
      }
    }
  });

  socket.on('job-status-update', async (data) => {
    console.log(`Status update for job ${data.jobId}: ${data.status}`);
    try {
      await PrintJob.findByIdAndUpdate(data.jobId, { 
        status: data.status,
        updatedAt: new Date()
      });
    } catch (error) {
      console.error('Failed to update job status:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('✗ Printer agent disconnected:', socket.id);
    connectedPrinters.delete(socket.id);
  });
});



app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     Cloud Printer System Started       ║
╠════════════════════════════════════════╣
║  Server: http://localhost:${PORT}         ║
║  Status: Ready to accept print jobs    ║
╚════════════════════════════════════════╝
  `);
});
