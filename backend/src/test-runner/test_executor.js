const { remote } = require('webdriverio');
const fs = require('fs');
const path = require('path');
const convert = require('xml-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const FormData = require('form-data');
// Import the updated NLP service functions
const { translateStepsToCommands, findCorrectSelector } = require('../services/nlp_service');

// Import shared configuration.  This loads environment variables and
// exposes BrowserStack credentials.  Avoid calling dotenv here to
// prevent multiple config loads.
const config = require('../config');

// --- BrowserStack Credentials ---
// Read credentials from config.  If either credential is missing,
// BrowserStack tests will throw an explicit error when attempted.
const BROWSERSTACK_USERNAME = config.browserStackUsername;
const BROWSERSTACK_ACCESS_KEY = config.browserStackAccessKey;

// --- POM Caching Logic with Platform-Specific File Persistence ---
let POM_FILE_PATH = null;
let pomCache = {};

/**
 * Loads the POM cache for the specified platform from disk.
 * Defaults to an empty cache if no file exists or loading fails.
 *
 * @param {string} platform - Either `android` or `ios`.
 */
function loadCache(platform = 'android') {
    POM_FILE_PATH = path.join(
        __dirname,
        `../../pom_${platform}.json`,
    );
    try {
        if (fs.existsSync(POM_FILE_PATH)) {
            const data = fs.readFileSync(POM_FILE_PATH, 'utf8');
            pomCache = JSON.parse(data);
            console.log(
                `Successfully loaded ${platform} POM cache from ${path.basename(POM_FILE_PATH)}`,
            );
        } else {
            pomCache = {};
        }
    } catch (error) {
        console.error(
            `Could not load POM cache from ${path.basename(POM_FILE_PATH)}:`,
            error,
        );
        pomCache = {}; // Start with an empty cache if loading fails
    }
}

/**
 * Saves the current state of the POM cache to the platform-specific file.
 */
function saveCache() {
    if (!POM_FILE_PATH) return;
    try {
        fs.writeFileSync(POM_FILE_PATH, JSON.stringify(pomCache, null, 2), 'utf8');
        console.log(`POM cache saved to ${path.basename(POM_FILE_PATH)}`);
    } catch (error) {
        console.error(
            `Could not save POM cache to ${path.basename(POM_FILE_PATH)}:`,
            error,
        );
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
            // Retain both Android and iOS specific attributes so the AI
            // service has enough context to build reliable selectors.
            const attributesToKeep = [
                // --- Common / Android attributes ---
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
                // --- iOS attributes ---
                'name',
                'label',
                'value',
                'visible',
                'accessible',
                'type',
                'x',
                'y',
                'width',
                'height',
                'index',
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
 * Waits for any obvious loading indicators to disappear.  Many Android apps
 * display an indeterminate progress bar or spinner while fetching data.  If
 * these elements remain on the screen, capturing a page source too early can
 * return the loading overlay rather than the actual page.  This helper
 * attempts to locate a variety of common progress indicators and waits for
 * them to be removed from the UI.
 *
 * @param {object} browser - The WebdriverIO browser instance.
 * @param {number} timeout - Maximum time to wait for indicators to disappear.
 */
async function waitForLoadingToDisappear(browser, platform = 'android', timeout = 15000) {
    /*
     * Waits for common loading spinners or progress indicators to disappear.
     * On Android, this looks for ProgressBar widgets and resource IDs containing
     * "progress" or "loading".  On iOS, it searches via the iOS class chain
     * for activity and progress indicators.  If the element exists, it
     * waits for it to disappear using the reverse option on waitForExist.
     */
    const start = Date.now();
    if ((platform || 'android').toLowerCase() === 'ios') {
        // iOS selectors via class chain
        const iosChains = [
            '**/XCUIElementTypeActivityIndicator',
            '**/XCUIElementTypeProgressIndicator',
        ];
        for (const chain of iosChains) {
            try {
                const element = await browser.$(`-ios class chain:${chain}`);
                if (await element.isExisting()) {
                    await element.waitForExist({
                        timeout: timeout - (Date.now() - start),
                        reverse: true,
                    });
                }
            } catch (err) {
                // If not found or invalid selector, ignore and continue
            }
        }
    } else {
        // Android selectors: widget class or resource/text contains progress/loading
        const selectors = [
            'android.widget.ProgressBar',
            '//*[contains(@resource-id, "progress")]',
            '//*[contains(@resource-id, "loading")]',
            '//*[contains(translate(@text, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "loading")]',
        ];
        for (const selector of selectors) {
            try {
                const element = await browser.$(selector);
                if (await element.isExisting()) {
                    await element.waitForExist({
                        timeout: timeout - (Date.now() - start),
                        reverse: true,
                    });
                }
            } catch (err) {
                // Ignore invalid selectors or not found errors
            }
        }
    }
}

/**
 * Waits for the UI to reach a steady state by polling the page source until it
 * stops changing.  Capturing a page source while the UI is still updating
 * (e.g. during animation or data binding) can lead to transient XML trees.
 * This function fetches the page source repeatedly and returns once two
 * consecutive snapshots are identical, or after a timeout.
 *
 * @param {object} browser - The WebdriverIO browser instance.
 * @param {number} timeout - Maximum time to wait for stability.
 * @param {number} interval - Time in milliseconds between polls.
 * @returns {Promise<string>} The final page source.
 */
async function waitForPageStability(browser, timeout = 30000, interval = 1000) {
    //browser.pause(timeout); // Initial pause to allow any immediate changes
    let lastSource = null;
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const currentSource = await browser.getPageSource();
        if (lastSource && currentSource === lastSource) {
            // The page source has not changed since the last poll; assume stable
            return currentSource;
        }
        lastSource = currentSource;
        await browser.pause(interval);
    }
    // Timeout reached; return the most recent source even if not stable
    return lastSource;
}

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
 * Executes a series of structured commands on a mobile device using WebdriverIO and Appium.
 * Supports both Android and iOS.  iOS tests are only supported on BrowserStack.
 *
 * @param {string} appPath - The absolute path to the .apk or .ipa file.
 * @param {string} rawStepsText - The raw natural language steps from the user as a single string.
 * @param {object} io - The Socket.IO instance for emitting real-time updates.
 * @param {string} socketId - The ID of the client's socket connection.
 * @param {string} aiService - The AI service to use ('gemini' or 'deepseek').
 * @param {string} testEnvironment - The environment to run on ('local' or 'browserstack').
 * @param {string} platform - Target platform ('android' or 'ios').  Defaults to 'android' if undefined.
 * @param {string} deviceName - Desired device name when running on BrowserStack.  Optional.
 * @param {string} platformVersion - Desired OS version when running on BrowserStack.  Optional.
 */
async function executeTest(
    appPath,
    rawStepsText,
    io,
    socketId,
    aiService,
    testEnvironment,
    platform = 'android',
    deviceName = '',
    platformVersion = '',
) {
    let browser;
    // Normalise the platform once so that helper functions can use it.  This
    // variable persists through the lifetime of the test execution.
    const targetPlatform = (platform || 'android').toLowerCase();

    // Load the platform-specific POM cache before executing any steps
    loadCache(targetPlatform);

    try {
        let capabilities;
        let appiumOptions = {};

        // Build capabilities based on platform and environment

        if (testEnvironment === 'browserstack') {
            // BrowserStack execution for both Android and iOS
            const app_url = await uploadToBrowserStack(appPath);
            // Common BrowserStack options
            const bstackOptions = {
                userName: BROWSERSTACK_USERNAME,
                accessKey: BROWSERSTACK_ACCESS_KEY,
                deviceName: deviceName || (targetPlatform === 'ios' ? 'iPhone 15' : 'Samsung Galaxy S23'),
                osVersion: platformVersion || (targetPlatform === 'ios' ? '17' : '13.0'),
                projectName: process.env.BS_PROJECT_NAME || 'AI Mobile Tester',
                buildName:
                    (process.env.BS_BUILD_PREFIX || 'Build') + '-' + new Date().toISOString().slice(0, 10),
                debug: true,
                networkLogs: true,
                appiumVersion: process.env.BS_APPIUM_VERSION || undefined,
            };
            // Remove undefined keys from bstackOptions
            Object.keys(bstackOptions).forEach(
                (key) => bstackOptions[key] === undefined && delete bstackOptions[key],
            );
            appiumOptions = {
                hostname: 'hub-cloud.browserstack.com',
                port: 443,
                // --- FIX: Explicitly set the protocol to HTTPS ---
                protocol: 'https',
                path: '/wd/hub',
                logLevel: 'error',
                connectionRetryTimeout: 120000, // 2 minutes
                connectionRetryCount: 3,
            };
            if (targetPlatform === 'ios') {
                capabilities = {
                    platformName: 'iOS',
                    'appium:automationName': 'XCUITest',
                    'appium:app': app_url,
                    'bstack:options': bstackOptions,
                    'appium:autoDismissAlerts': true, // Auto-dismiss iOS alerts
                };
            } else {
                // Android on BrowserStack
                capabilities = {
                    platformName: 'Android',
                    'appium:automationName': 'UiAutomator2',
                    'appium:app': app_url,
                    'bstack:options': bstackOptions,
                    'appium:autoGrantPermissions': true,
                };
            }
        } else {
            // Local execution (currently Android only)
            if (targetPlatform === 'ios') {
                throw new Error('iOS tests can only be executed on BrowserStack.');
            }
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
                'appium:app': path.resolve(appPath),
                'appium:noReset': false,
                'appium:autoGrantPermissions': true,
            };
        }

        console.log('Attempting to start remote session...');
        browser = await remote({ ...appiumOptions, capabilities });
        console.log('Remote session started successfully.');

        // --- NEW: Identify the app and prepare its specific cache ---
        // Use appPackage for Android or bundleId for iOS when caching selectors.
        const appId =
            browser.capabilities.appPackage || browser.capabilities.bundleId || 'unknown';
        console.log(`Identified app id: ${appId}`);
        if (!pomCache[appId]) {
            console.log(`No existing cache found for ${appId}. Creating a new one.`);
            pomCache[appId] = {};
        }
        const appSelectorCache = pomCache[appId];

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
            if (selector.toLowerCase().startsWith('name=')) {
                const name = selector.substring(5);
                console.log(`Attempting to find by Name: ${name}`);
                return await browser.$(`~${name}`);
            }
            if (selector.toLowerCase().startsWith('label=')) {
                const label = selector.substring(6);
                console.log(`Attempting to find by Label: ${label}`);
                return await browser.$(`//*[@label="${label}"]`);
            }
            if (selector.includes(':id/')) {
                console.log(`Attempting to find by Resource ID: ${selector}`);
                return await browser.$(`id:${selector}`);
            }
            console.log(
                `Attempting to find by flexible XPath for text: "${selector}"`,
            );
            const lowered = selector.toLowerCase();
            const xpathSelector =
                `//*[contains(translate(@text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}") ` +
                `or contains(translate(@content-desc, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}") ` +
                `or contains(translate(@name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}") ` +
                `or contains(translate(@label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}")]`;
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

                // --- NEW: Wait for element in the next step instead of a fixed pause ---
                if (lowerCaseStep.includes('wait for app to load')) {
                    console.log(`--- Executing intelligent wait: "${step}" ---`);

                    // Update page context if provided
                    const match = step.match(/wait for app to load the (.*) page/i);
                    if (match && match[1]) {
                        currentPageName = match[1].trim().toLowerCase();
                        console.log(`Page context updated to: "${currentPageName}"`);
                    }

                    const nextStep = allSteps[i + 1];
                    if (nextStep) {
                        let nextSelector;
                        try {
                            const pageSource = await waitForPageStability(browser, 30000, 1000);
                            const cleanedSource = cleanPageSource(pageSource);
                            const nextCommandResp = await translateStepsToCommands(
                                nextStep,
                                cleanedSource,
                                aiService,
                            );
                            const nextCommand = Array.isArray(nextCommandResp)
                                ? nextCommandResp[0]
                                : nextCommandResp;
                            nextSelector = nextCommand && nextCommand.selector;
                        } catch (err) {
                            console.log('Error determining next step selector:', err.message);
                        }

                        if (nextSelector) {
                            try {
                                const element = await findElement(nextSelector);
                                await element.waitForDisplayed({ timeout: 30000, interval: 2000 });
                                console.log('Next step element is now visible.');
                            } catch (waitErr) {
                                console.log('Failed waiting for next step element:', waitErr.message);
                            }
                        } else {
                            console.log(
                                'Could not derive selector for next step; falling back to 3 second pause.',
                            );
                            await browser.pause(3000);
                        }
                    } else {
                        console.log('No subsequent step found. Skipping dynamic wait.');
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
        // Optionally remove the uploaded app file to keep the uploads folder
        // clean.  This behaviour is controlled by the CLEAN_UPLOADS_AFTER_TEST
        // environment variable (see config.js).  We read directly from
        // process.env here to avoid introducing a dependency on config.js in
        // the test runner.
        const cleanUploads = (process.env.CLEAN_UPLOADS_AFTER_TEST || 'false').toLowerCase() === 'true';
        try {
            if (cleanUploads && typeof appPath === 'string') {
                fs.unlinkSync(appPath);
                console.log(`Deleted uploaded app: ${appPath}`);
            }
        } catch (fileCleanupError) {
            console.error('Failed to delete uploaded app file:', fileCleanupError);
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
    // First, look for text wrapped in asterisks, e.g. *element*.
    const asteriskMatch = step.match(/\*([^*]+)\*/);
    if (asteriskMatch && asteriskMatch[1]) {
        return `*${asteriskMatch[1]}*`;
    }

    // Finally, return the last word if no special delimiters are found.
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

module.exports = { executeTest, extractElementName };