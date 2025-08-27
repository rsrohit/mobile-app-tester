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
//
// We accept both Android (.apk) and iOS (.ipa) packages.  The extension
// check is case‑insensitive.  If an unsupported file type is uploaded
// the request will fail with a 400 error.
const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.apk', '.ipa'].includes(ext)) {
      return cb(new Error('Only .apk or .ipa files are allowed!'), false);
    }
    cb(null, true);
  },
});

const router = express.Router();
// Import test service for managing test definitions
const { getAllTests, getTestById, saveTest } = require('../services/test_service');

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

    // Read additional parameters for platform and device configuration.  If
    // not provided, default to Android.  BrowserStack iOS runs require
    // platform set to 'ios'.
    const platform = (req.body.platform || 'android').toLowerCase();
    const deviceName = req.body.deviceName || '';
    const platformVersion = req.body.platformVersion || '';

    console.log(
      `Received test request from socket: ${socketId} using AI service: ${aiService} on environment: ${testEnvironment}`,
    );
    if (apkFile) console.log('APK File:', apkFile.filename);

    // Basic validation
    if (!apkFile || !testSteps || !socketId) {
      return res.status(400).json({ message: 'Missing APK/IPA file, test steps, or socket ID.' });
    }

    // iOS tests can only run on BrowserStack.  Reject any attempt to run
    // iOS locally.  The frontend should enforce this, but we check again
    // on the server for safety.
    if (platform === 'ios' && testEnvironment !== 'browserstack') {
      return res
        .status(400)
        .json({ message: 'iOS tests are supported on BrowserStack only.' });
    }

    // Immediately respond to the client; test runs asynchronously
    res.status(200).json({
      message: 'Test request received and is being processed.',
      file: apkFile.filename,
    });

    // Kick off the test execution asynchronously.  No need to await.
    executeTest(
      apkFile.path,
      testSteps,
      io,
      socketId,
      aiService,
      testEnvironment,
      platform,
      deviceName,
      platformVersion,
    ).catch((err) => {
      // Top‑level error catch.  Log errors here because the test
      // executor already emits error events via Socket.IO.
      console.error('Unhandled error in test execution:', err);
    });
  });

  /**
   * GET /api/tests
   * Returns a list of available test definitions.  Accepts an optional
   * `tag` query parameter to filter tests by tag.  Each item in the
   * response contains the test id, name, and tags.
   */
  router.get('/tests', (req, res) => {
    try {
      const tag = req.query.tag;
      const tests = getAllTests(tag);
      res.status(200).json({ tests });
    } catch (err) {
      console.error('Failed to list tests:', err);
      res.status(500).json({ message: 'Unable to list tests' });
    }
  });

  /**
   * GET /api/tests/:id
   * Returns the full definition of a single test, including its steps.  If the
   * test does not exist, responds with 404.
   */
  router.get('/tests/:id', (req, res) => {
    const { id } = req.params;
    const test = getTestById(id);
    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }
    res.status(200).json({ test });
  });

  /**
   * POST /api/tests
   * Create a new test definition.  Expects a JSON body with `name`,
   * `tags` (array of strings) and `steps` (array of strings).  The test
   * is saved to the tests directory and a unique id is generated.  The
   * response contains the generated id.
   */
  router.post('/tests', (req, res) => {
    const { name, tags, steps } = req.body || {};
    try {
      const id = saveTest({ name, tags, steps });
      res.status(201).json({ id, message: 'Test created successfully' });
    } catch (err) {
      console.error('Failed to save test:', err);
      res.status(400).json({ message: err.message || 'Invalid test definition' });
    }
  });

  /**
   * POST /api/run-tests
   * Run one or more existing test definitions.  Accepts the same
   * parameters as /run-test plus `testIds`, which can be a JSON array or
   * comma-separated string of test ids.  The specified tests will be
   * executed sequentially.  Only one APK file is required; it will be
   * reused for each test.  Returns immediately with a 200 status; test
   * progress and completion events are emitted via Socket.IO.
   */
  router.post('/run-tests', upload.single('apkFile'), (req, res) => {
    let testIds = req.body.testIds;
    const apkFile = req.file;
    const socketId = req.body.socketId;
    const aiService = req.body.aiService || 'gemini';
    const testEnvironment = req.body.testEnvironment || 'local';

    const platform = (req.body.platform || 'android').toLowerCase();
    const deviceName = req.body.deviceName || '';
    const platformVersion = req.body.platformVersion || '';

    if (!apkFile || !testIds || !socketId) {
      return res.status(400).json({ message: 'Missing APK/IPA file, test IDs, or socket ID.' });
    }

    if (platform === 'ios' && testEnvironment !== 'browserstack') {
      return res
        .status(400)
        .json({ message: 'iOS tests are supported on BrowserStack only.' });
    }

    // Parse testIds which may be provided as JSON string or comma-separated values
    if (typeof testIds === 'string') {
      try {
        testIds = JSON.parse(testIds);
      } catch (err) {
        testIds = testIds.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(testIds) || testIds.length === 0) {
      return res.status(400).json({ message: 'testIds must be an array of test identifiers.' });
    }

    console.log(
      `Received multi-test request for tests: ${testIds.join(', ')} from socket: ${socketId} using AI service: ${aiService} on environment: ${testEnvironment}`,
    );
    if (apkFile) console.log('APK File:', apkFile.filename);

    res.status(200).json({
      message: 'Test run request received and is being processed.',
      file: apkFile.filename,
    });

    // Helper to run tests sequentially
    async function runSequential() {
      for (const testId of testIds) {
        const testDef = getTestById(testId);
        if (!testDef) {
          console.warn(`Test definition ${testId} not found. Skipping.`);
          continue;
        }
        const rawSteps = testDef.steps.join('\n');
        try {
          await executeTest(
            apkFile.path,
            rawSteps,
            io,
            socketId,
            aiService,
            testEnvironment,
            platform,
            deviceName,
            platformVersion,
          );
        } catch (err) {
          console.error(`Error executing test ${testId}:`, err);
          // Continue to next test; errors will be emitted via socket events
        }
      }
    }
    runSequential().catch((err) => console.error('Error running tests sequentially:', err));
  });

  return router;
};

module.exports = routes;