const { remote } = require('webdriverio');
const fs = require('fs');
const path = require('path');
const convert = require('xml-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const FormData = require('form-data');
// Import the updated NLP service functions
const { translateStepsToCommands, findCorrectSelector, getPageLoadIndicator } = require('../services/nlp_service');

// Import shared configuration.  This loads environment variables and
// exposes BrowserStack credentials.  Avoid calling dotenv here to
// prevent multiple config loads.
const config = require('../config');

// --- BrowserStack Credentials ---
// Read credentials from config.  If either credential is missing,
// BrowserStack tests will throw an explicit error when attempted.
const BROWSERSTACK_USERNAME = config.browserStackUsername;
const BROWSERSTACK_ACCESS_KEY = config.browserStackAccessKey;

// --- POM Caching Logic with File Persistence ---
const POM_FILE_PATH = path.join(__dirname, '../../pom.json');
let pomCache = {};

// Load the entire multi-app cache from the file system on startup
try {
    if (fs.existsSync(POM_FILE_PATH)) {
        const data = fs.readFileSync(POM_FILE_PATH, 'utf8');
        pomCache = JSON.parse(data);
        console.log('Successfully loaded multi-app POM cache from pom.json');
    }
} catch (error) {
    console.error('Could not load POM cache from pom.json:', error);
    pomCache = {}; // Start with an empty cache if loading fails
}

/**
 * Saves the current state of the entire POM cache to the pom.json file.
 */
function saveCache() {
    try {
        fs.writeFileSync(POM_FILE_PATH, JSON.stringify(pomCache, null, 2), 'utf8');
        console.log('POM cache saved to pom.json');
    } catch (error) {
        console.error('Could not save POM cache to pom.json:', error);
    }
}

/**
 * Reduces the size of the XML to avoid API request limits.
 * @param {string} xml - The raw XML page source from Appium.
 * @returns {string} A cleaned, smaller XML string.
 */
function cleanPageSource(xml) {
    try {
        const options = { compact: true, ignoreComment: true, spaces: 2 };
        const json = convert.xml2js(xml, options);

        // Recursive function to remove non-essential attributes from each node
        function cleanNode(node) {
            if (!node) return;
            const attributesToKeep = [
                'class',
                'resource-id',
                'content-desc',
                'text',
                'package',
                'checkable',
                'checked',
                'clickable',
                'enabled',
                'selected',
            ];
            if (node._attributes) {
                const newAttributes = {};
                for (const key of attributesToKeep) {
                    if (node._attributes[key] !== undefined) {
                        newAttributes[key] = node._attributes[key];
                    }
                }
                node._attributes = newAttributes;
            }
            // Recurse through all children nodes
            for (const key in node) {
                if (key !== '_attributes' && key !== '_text') {
                    if (Array.isArray(node[key])) {
                        node[key].forEach(cleanNode);
                    } else if (typeof node[key] === 'object') {
                        cleanNode(node[key]);
                    }
                }
            }
        }
        cleanNode(json);
        return convert.js2xml(json, { compact: true, spaces: 2 });
    } catch (error) {
        console.error('Failed to clean XML page source, returning original.', error);
        return xml; // Fallback to the original XML if cleaning fails
    }
}

/**
 * Uploads an APK to BrowserStack and returns the app_url.
 * @param {string} apkPath - The local path to the .apk file.
 * @returns {Promise<string>} The app_url from BrowserStack.
 */
async function uploadToBrowserStack(apkPath) {
    if (!BROWSERSTACK_USERNAME || !BROWSERSTACK_ACCESS_KEY) {
        throw new Error(
            'BrowserStack credentials are missing. Set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY in your environment.'
        );
    }
    console.log('Uploading APK to BrowserStack...');

    const form = new FormData();
    form.append('file', fs.createReadStream(apkPath));

    const response = await fetch('https://api-cloud.browserstack.com/app-automate/upload', {
        method: 'POST',
        headers: {
            Authorization:
                'Basic ' + Buffer.from(`${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}`).toString('base64'),
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

/**
 * Executes a series of structured commands on an Android device using WebdriverIO and Appium.
 * @param {string} apkPath - The absolute path to the .apk file.
 * @param {string} rawStepsText - The raw natural language steps from the user as a single string.
 * @param {object} io - The Socket.IO instance for emitting real-time updates.
 * @param {string} socketId - The ID of the client's socket connection.
 * @param {string} aiService - The AI service to use ('gemini' or 'deepseek').
 * @param {string} testEnvironment - The environment to run on ('local' or 'browserstack').
 */
async function executeTest(
    apkPath,
    rawStepsText,
    io,
    socketId,
    aiService,
    testEnvironment,
) {
    let browser;
    try {
        let capabilities;
        let appiumOptions = {};

        if (testEnvironment === 'browserstack') {
            const app_url = await uploadToBrowserStack(apkPath);
            appiumOptions = {
                hostname: 'hub-cloud.browserstack.com',
                port: 4444,
                path: '/wd/hub',
                logLevel: 'error',
                connectionRetryTimeout: 120000, // 2 minutes
                connectionRetryCount: 3,
            };
            capabilities = {
                'bstack:options': {
                    userName: BROWSERSTACK_USERNAME,
                    accessKey: BROWSERSTACK_ACCESS_KEY,
                    deviceName: 'Samsung Galaxy S23', // Example device
                    platformVersion: '13.0',
                    projectName: 'AI Mobile Tester',
                    buildName: `Build-${Date.now()}`,
                    debug: true,
                    networkLogs: true,
                },
                platformName: 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:app': app_url,
            };
        } else {
            // Default to local execution. Allow overriding the Appium host/port via environment variables.
            const appiumHost = process.env.APPIUM_HOST || '127.0.0.1';
            const appiumPort = parseInt(process.env.APPIUM_PORT || '4723', 10);
            appiumOptions = {
                hostname: appiumHost,
                port: appiumPort,
                logLevel: 'error',
            };
            capabilities = {
                platformName: 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:deviceName': 'Android Emulator',
                'appium:app': path.resolve(apkPath),
                'appium:noReset': false,
                'appium:autoGrantPermissions': true,
            };
        }

        console.log('Attempting to start remote session...');
        browser = await remote({ ...appiumOptions, capabilities });
        console.log('Remote session started successfully.');

        // --- NEW: Identify the app and prepare its specific cache ---
        const appPackage = browser.capabilities.appPackage;
        console.log(`Identified app package: ${appPackage}`);
        if (!pomCache[appPackage]) {
            console.log(`No existing cache found for ${appPackage}. Creating a new one.`);
            pomCache[appPackage] = {};
        }
        const appSelectorCache = pomCache[appPackage];

        // --- NEW: Define findElement at a higher scope ---
        const findElement = async (selector) => {
            if (!selector) throw new Error('Selector is null or undefined.');

            if (selector.toLowerCase().startsWith('resource-id:')) {
                const resourceId = selector.substring(12);
                console.log(`Attempting to find by parsed Resource ID: ${resourceId}`);
                return await browser.$(`id:${resourceId}`);
            }
            if (selector.toLowerCase().startsWith('resource-id=')) {
                const resourceId = selector.substring(12);
                console.log(`Attempting to find by parsed Resource ID: ${resourceId}`);
                return await browser.$(`id:${resourceId}`);
            }
            if (selector.toLowerCase().startsWith('new uiselector')) {
                let sanitizedSelector = selector;
                const resourceIdMatch = selector.match(/resourceId\(([^)]+)\)/);
                if (resourceIdMatch && !resourceIdMatch[1].startsWith('"')) {
                    sanitizedSelector = selector.replace(resourceIdMatch[1], `"${resourceIdMatch[1]}"`);
                }
                console.log(`Attempting to find by UiSelector: ${sanitizedSelector}`);
                return await browser.$(`android=${sanitizedSelector}`);
            }
            if (selector.startsWith('~')) {
                console.log(`Attempting to find by Accessibility ID: ${selector}`);
                return await browser.$(selector);
            }
            if (selector.includes(':id/')) {
                console.log(`Attempting to find by Resource ID: ${selector}`);
                return await browser.$(`id:${selector}`);
            }
            console.log(
                `Attempting to find by flexible XPath for text: "${selector}"`,
            );
            const xpathSelector = `//*[contains(translate(@text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${selector.toLowerCase()}") or contains(translate(@content-desc, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${selector.toLowerCase()}")]`;
            return await browser.$(xpathSelector);
        };

        // --- PAGE-AWARE GROUPING LOGIC ---
        console.log('Starting page-aware grouped test execution...');

        const allSteps = rawStepsText.split('\n').filter((s) => s.trim() !== '');

        let stepCounter = 0;
        let currentPageName = 'initial'; // Track the current page context

        for (let i = 0; i < allSteps.length; i++) {
            const step = allSteps[i];
            stepCounter++;
            const stepNumber = stepCounter;
            const lowerCaseStep = step.toLowerCase();

            io.to(socketId).emit('step-update', { stepNumber, status: 'running' });

            try {
                // --- FIX: Handle simple steps directly without AI ---
                if (lowerCaseStep.includes('launch the app')) {
                    console.log(`--- Executing direct command: "${step}" ---`);
                    await browser.pause(2000);
                    io.to(socketId).emit('step-update', { stepNumber, status: 'passed' });
                    continue; // Move to the next step
                }

                // --- NEW: Implement intelligent, AI-driven waits ---
                if (lowerCaseStep.includes('wait for app to load')) {
                    console.log(`--- Executing intelligent wait: "${step}" ---`);
                    const match = step.match(/wait for app to load the (.*) page/i);
                    if (match && match[1]) {
                        currentPageName = match[1].trim().toLowerCase();
                        console.log(`Page context updated to: "${currentPageName}"`);

                        // Wait a moment for the transition to begin
                        await browser.pause(1000);

                        const pageSource = await browser.getPageSource();
                        const cleanedSource = cleanPageSource(pageSource);

                        let indicatorSelector = await getPageLoadIndicator(
                            currentPageName,
                            cleanedSource,
                            aiService,
                        );
                        // --- FIX: Sanitize the selector from the AI ---
                        indicatorSelector = indicatorSelector.replace(/[`"']/g, '');

                        console.log(
                            `AI identified "${indicatorSelector}" as the key element for the ${currentPageName} page.`,
                        );

                        // --- FIX: Use the robust findElement function for waiting ---
                        const indicatorElement = await findElement(indicatorSelector);
                        await indicatorElement.waitForExist({ timeout: 30000, interval: 2000 }); // Wait up to 30 seconds
                        console.log(
                            `Successfully verified that the ${currentPageName} page has loaded.`,
                        );
                    } else {
                        await browser.pause(3000); // Fallback to a simple pause if no page name is found
                    }
                    io.to(socketId).emit('step-update', { stepNumber, status: 'passed' });
                    continue; // Move to the next step
                }

                // --- For complex steps, use the AI ---
                console.log(
                    `--- Executing AI-driven step: "${step}" on page: "${currentPageName}" ---`,
                );
                const pageSource = await browser.getPageSource();
                const cleanedSource = cleanPageSource(pageSource);

                // We ask the AI to translate just this one complex step
                const commandResponse = await translateStepsToCommands(
                    step,
                    cleanedSource,
                    aiService,
                );
                console.log('Received context-aware command:', commandResponse);

                // --- FIX: Gracefully handle empty or invalid responses from the AI ---
                let commandToExecute = Array.isArray(commandResponse)
                    ? commandResponse[0]
                    : commandResponse;

                if (!commandToExecute || !commandToExecute.command) {
                    console.log(
                        'AI could not determine a command. Creating a placeholder to trigger self-healing.',
                    );
                    commandToExecute = {
                        command: 'verifyVisible', // A safe default command
                        selector: null, // A null selector will always fail the first attempt, triggering self-healing
                        original_step: step,
                    };
                }

                await executeCommand(
                    browser,
                    commandToExecute,
                    aiService,
                    appSelectorCache,
                    currentPageName,
                    step,
                    findElement,
                );
                io.to(socketId).emit('step-update', { stepNumber, status: 'passed' });

            } catch (stepError) {
                console.error(`Error on step ${stepNumber}:`, stepError.message);
                io.to(socketId).emit('step-update', {
                    stepNumber,
                    status: 'failed',
                    details: { error: stepError.message },
                });
                throw new Error(`Test failed at step ${stepNumber}: ${step}`);
            }
        }

        console.log('Test execution completed successfully.');
        io.to(socketId).emit('test-complete', { message: 'Test finished successfully!' });
     } catch (error) {
        console.error('An error occurred during the test execution:', error);
        io.to(socketId).emit('test-error', {
            message: error.message || 'A critical error occurred in the test executor.',
        });
     } finally {
         try {
             // Always attempt to persist the POM cache to disk at the end of a test.
             saveCache();
         } catch (cacheError) {
             console.error('Failed to persist POM cache on shutdown:', cacheError);
         }
         // Ensure the Appium session is closed
         if (browser) {
             await browser.deleteSession();
         }
         // Optionally remove the uploaded APK file to keep the uploads folder
         // clean.  This behaviour is controlled by the CLEAN_UPLOADS_AFTER_TEST
         // environment variable (see config.js).  We read directly from
         // process.env here to avoid introducing a dependency on config.js in
         // the test runner.
         const cleanUploads = (process.env.CLEAN_UPLOADS_AFTER_TEST || 'false').toLowerCase() === 'true';
         try {
             if (cleanUploads && typeof apkPath === 'string') {
                 fs.unlinkSync(apkPath);
                 console.log(`Deleted uploaded APK: ${apkPath}`);
             }
         } catch (fileCleanupError) {
             console.error('Failed to delete uploaded APK:', fileCleanupError);
         }
     }
}

/**
 * Extracts the core element name from a natural language step.
 * e.g., "Click on 'Login' button" -> "'Login' button"
 * @param {string} step - The natural language step.
 * @returns {string} The extracted element name or the original step.
 */
function extractElementName(step) {
    // This regex looks for text in single quotes, or the last word if no quotes are found.
    const quoteMatch = step.match(/'([^']+)'/);
    if (quoteMatch && quoteMatch[1]) {
        return `'${quoteMatch[1]}'`;
    }
    const words = step.trim().split(' ');
    return words[words.length - 1];
}

/**
 * Helper function to execute a single command with robust selector strategies and self-healing.
 * @param {object} browser - The WebdriverIO browser instance.
 * @param {object} command - The command object to execute.
 * @param {string} aiService - The AI service to use for self-healing.
 * @param {object} appSelectorCache - The selector cache for the specific app being tested.
 * @param {string} currentPageName - The name of the current page for context-aware caching.
 * @param {string} originalStepText - The original raw text of the step.
 * @param {Function} findElement - The robust findElement helper function.
 */
async function executeCommand(
    browser,
    command,
    aiService,
    appSelectorCache,
    currentPageName,
    originalStepText,
    findElement,
) {
    // Normalize the command object in case the AI response is malformed
    const safeCommand = command || {};
    safeCommand.original_step = originalStepText;

    const performAction = async (element) => {
        if (safeCommand.command === 'click') {
            await element.click();
        } else if (safeCommand.command === 'setValue') {
            await element.setValue(safeCommand.value);
        }
    };

    // --- NEW, MORE ROBUST EXECUTION FLOW ---
    const elementName = extractElementName(safeCommand.original_step);
    const cacheKey = `${currentPageName} - ${elementName}`;
    let element;
    let finalSelector;

    // 1. Try the cache first
    if (appSelectorCache[cacheKey]) {
        try {
            const cachedSelector = appSelectorCache[cacheKey];
            console.log(`Found cached selector for step "${cacheKey}": "${cachedSelector}"`);
            element = await findElement(cachedSelector);
            await element.waitForExist({ timeout: 5000 });
            console.log('Successfully found element using cached selector.');
            await performAction(element);
            return; // Success, end of function
        } catch (e) {
            console.log('Cached selector failed. Deleting it and trying AI.');
            delete appSelectorCache[cacheKey];
            saveCache();
        }
    }

    // 2. If cache fails or doesn't exist, try the AI's initial suggestion
    try {
        if (!safeCommand.selector) {
            // This will make it jump directly to the catch block for self-healing
            throw new Error('AI did not provide an initial selector.');
        }
        console.log(`Executing step with AI-provided selector: "${safeCommand.selector}"`);
        element = await findElement(safeCommand.selector);
        await element.waitForExist({ timeout: 10000 });
        console.log('Found element successfully with AI-provided selector.');
        finalSelector = safeCommand.selector;
    } catch (initialError) {
        // 3. If initial attempt fails, initiate self-healing
        console.log(`${initialError.message} Initiating self-healing protocol.`);
        try {
            const pageSource = await browser.getPageSource();
            const cleanedSourceForHealing = cleanPageSource(pageSource);
            let newSelector = await findCorrectSelector(
                safeCommand.original_step,
                cleanedSourceForHealing,
                aiService,
            );
            newSelector = newSelector.replace(/[`"']/g, '');

            console.log(
                `Self-healing: Retrying step with AI-suggested selector: "${newSelector}"`,
            );
            element = await findElement(newSelector);
            await element.waitForExist({ timeout: 10000 });

            console.log('Successfully found element with AI-healed selector.');
            finalSelector = newSelector;
        } catch (healingError) {
            console.error('Self-healing also failed.', healingError);
            throw new Error(
                `Could not find element for step: "${safeCommand.original_step}"`,
            );
        }
    }

    // 4. Perform action and save to cache
    await performAction(element);
    if (finalSelector) {
        appSelectorCache[cacheKey] = finalSelector;
        saveCache();
    }
    await browser.pause(1000);
}

module.exports = { executeTest };