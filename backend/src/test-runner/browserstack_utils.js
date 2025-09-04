const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const FormData = require('form-data');
const config = require('../config');

const BROWSERSTACK_USERNAME = config.browserStackUsername;
const BROWSERSTACK_ACCESS_KEY = config.browserStackAccessKey;

/**
 * Uploads a mobile app package (APK or IPA) to BrowserStack and returns the app_url.
 * BrowserStack accepts both Android (.apk) and iOS (.ipa) binaries.  The caller
 * is responsible for ensuring only supported file types are provided.
 *
 * @param {string} filePath - The local path to the .apk or .ipa file.
 * @returns {Promise<string>} The app_url from BrowserStack.
 */
async function uploadToBrowserStack(filePath) {
    if (!BROWSERSTACK_USERNAME || !BROWSERSTACK_ACCESS_KEY) {
        throw new Error(
            'BrowserStack credentials are missing. Set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY in your environment.'
        );
    }
    console.log('Uploading app to BrowserStack...');

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));

    const response = await fetch('https://api-cloud.browserstack.com/app-automate/upload', {
        method: 'POST',
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}`).toString('base64'),
        },
        body: form,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`BrowserStack upload failed: ${errorBody}`);
    }

    const data = await response.json();
    console.log('BrowserStack upload successful. App URL:', data.app_url);
    return data.app_url;
}

module.exports = { uploadToBrowserStack, BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY };
