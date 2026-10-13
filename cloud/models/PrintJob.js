import mongoose from 'mongoose';

const printJobSchema = new mongoose.Schema({
  filename: {
    type: String,
    required: true
  },
  originalName: {
    type: String,
    required: true
  },
  filePath: {
    type: String,
    required: true
  },
  fileUrl: {
    type: String,
    required: true
  },
  printerName: {
    type: String,
    required: true
  },
  pageCount: {
    type: Number,
    default: 0
  },
  copies: {
    type: Number,
    default: 1
  },
  color: {
    type: Boolean,
    default: false
  },
  duplex: {
    type: Boolean,
    default: false
  },
  pageRange: {
    type: String,
    default: 'all'  // e.g., 'all', '1-4', '1-4, 6-10', '3, 5, 7-12'
  },
  printPageCount: {
    type: Number,
    default: 0  // Actual pages to print (after page range applied)
  },
  batchId: {
    type: String,
    default: null
  },
  amount: {
    type: Number,
    default: 0
  },
  paymentId: {
    type: String,
    default: null
  },
  razorpayOrderId: {
    type: String,
    default: null
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending'
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'printing', 'completed', 'failed'],
    default: 'pending'
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const PrintJob = mongoose.model('PrintJob', printJobSchema);

export default PrintJob;
