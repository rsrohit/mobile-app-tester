const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { executeTest } = require('../test-runner/test_executor');
const config = require('../config');

// Ensure the upload directory exists before configuring storage.  Using
// recursive: true makes this idempotent even if the directory already
// exists.
fs.mkdirSync(config.uploadDir, { recursive: true });

// Configure multer for file storage using the configured uploadDir
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

// Configure multer upload with file size limits and file type filter
const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.apk') {
      return cb(new Error('Only .apk files are allowed!'), false);
    }
    cb(null, true);
  },
});

const router = express.Router();

/**
 * Defines all API routes.  The returned function accepts the Socket.IO
 * instance so that routes can emit real‑time updates to connected
 * clients.  This pattern avoids storing a global reference to io.
 *
 * @param {import('socket.io').Server} io The Socket.IO server instance.
 */
const routes = (io) => {
  // POST /api/run-test
  // Handles uploading an APK and running a test.  Expects fields
  // `testSteps`, `socketId`, `aiService` and `testEnvironment` in
  // the multipart/form-data body.
  router.post('/run-test', upload.single('apkFile'), (req, res) => {
    const testSteps = req.body.testSteps;
    const apkFile = req.file;
    const socketId = req.body.socketId;
    const aiService = req.body.aiService || 'gemini';
    const testEnvironment = req.body.testEnvironment || 'local';

    console.log(
      `Received test request from socket: ${socketId} using AI service: ${aiService} on environment: ${testEnvironment}`,
    );
    if (apkFile) console.log('APK File:', apkFile.filename);

    // Basic validation
    if (!apkFile || !testSteps || !socketId) {
      return res.status(400).json({ message: 'Missing APK file, test steps, or socket ID.' });
    }

    // Immediately respond to the client; test runs asynchronously
    res.status(200).json({
      message: 'Test request received and is being processed.',
      file: apkFile.filename,
    });

    // Kick off the test execution asynchronously.  No need to await.
    executeTest(apkFile.path, testSteps, io, socketId, aiService, testEnvironment)
      .catch((err) => {
        // Top‑level error catch.  Log errors here because the test
        // executor already emits error events via Socket.IO.
        console.error('Unhandled error in test execution:', err);
      });
  });

  return router;
};

module.exports = routes;