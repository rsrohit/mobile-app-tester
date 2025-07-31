const express = require('express');
const multer = require('multer');
const path = require('path');
// We don't need to import the NLP service here anymore, the executor handles it.
const { executeTest } = require('../test-runner/test_executor');

// Configure multer for file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../../../uploads/'));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname) !== '.apk') {
            return cb(new Error('Only .apk files are allowed!'), false);
        }
        cb(null, true);
    }
});

const router = express.Router();

const routes = (io) => {
    router.post('/run-test', upload.single('apkFile'), (req, res) => {
        const testSteps = req.body.testSteps;
        const apkFile = req.file;
        const socketId = req.body.socketId;
        const aiService = req.body.aiService || 'gemini'; // Default to gemini if not provided
        const testEnvironment = req.body.testEnvironment || 'local'; // Default to local

        console.log(`Received test request from socket: ${socketId} using AI service: ${aiService} on environment: ${testEnvironment}`);
        console.log('APK File:', apkFile.filename);

        if (!apkFile || !testSteps || !socketId) {
            return res.status(400).json({ message: 'Missing APK file, test steps, or socket ID.' });
        }

        res.status(200).json({ 
            message: 'Test request received and is being processed.',
            file: apkFile.filename
        });

        // Run the full test process asynchronously, passing the chosen AI service and environment
        executeTest(apkFile.path, testSteps, io, socketId, aiService, testEnvironment);
    });

    return router;
};

module.exports = routes;