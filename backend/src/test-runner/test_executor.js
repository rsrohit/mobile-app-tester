const { remote } = require('webdriverio');
const fs = require('fs');
const path = require('path');
const {
    cleanPageSource,
    waitForLoadingToDisappear,
    waitForPageStability,
} = require('./page_utils');
// Import the updated NLP service functions
const { translateStepsToCommands } = require('../services/nlp_service');
const { loadCache, saveCache, pomCache } = require('./pom_cache');
const {
    uploadToBrowserStack,
    BROWSERSTACK_USERNAME,
    BROWSERSTACK_ACCESS_KEY,
} = require('./browserstack_utils');
const {
    extractElementName,
    determineLocatorStrategy,
    executeCommand,
    createFindElement,
} = require('./command_utils');
const { switchToWebview, switchToNative } = require('./context_utils');

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
                    'appium:chromedriverAutodownload': true,
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
                'appium:chromedriverAutodownload': true,
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
        const findElement = createFindElement(browser);

        // --- PAGE-AWARE GROUPING LOGIC ---
        console.log('Starting page-aware grouped test execution...');

        const allSteps = rawStepsText.split('\n').filter((s) => s.trim() !== '');

        let stepCounter = 0;
        let currentPageName = 'initial'; // Track the current page context
        let activeContext = 'native'; // 'webview' or 'native'

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

                    if (lowerCaseStep.includes('webview')) {
                        console.log('Waiting for WebView context to be available...');
                        await switchToWebview(browser);
                        activeContext = 'webview';
                        console.log('Active context set to WebView for subsequent steps.');
                        io.to(socketId).emit('step-update', { stepNumber, status: 'passed' });
                        continue;
                    }

                    if (lowerCaseStep.includes('native view') || lowerCaseStep.includes('native')) {
                        console.log('Ensuring native context is active...');
                        await switchToNative(browser);
                        activeContext = 'native';
                        console.log('Active context set to Native for subsequent steps.');
                        io.to(socketId).emit('step-update', { stepNumber, status: 'passed' });
                        continue;
                    }

                    // Update page context if provided
                    const match = step.match(/wait for app to load the (.*) page/i);
                    if (match && match[1]) {
                        currentPageName = match[1].trim().toLowerCase();
                        console.log(`Page context updated to: "${currentPageName}"`);
                    }

                    const nextStep = allSteps[i + 1];
                    if (nextStep) {
                        const elementName = extractElementName(nextStep);
                        const prefix = `${currentPageName} - ${elementName} -`;
                        let cacheKey = Object.keys(appSelectorCache).find((k) =>
                            k.startsWith(prefix),
                        );
                        let finalSelector;

                        // Try cached selector if available
                        if (cacheKey) {
                            const cachedSelector = appSelectorCache[cacheKey];
                            try {
                                const element = await findElement(cachedSelector);
                                await element.waitForDisplayed({
                                    timeout: 30000,
                                    interval: 2000,
                                });
                                console.log('Next step element is now visible.');
                                finalSelector = cachedSelector;
                            } catch (err) {
                                console.log(
                                    'Cached selector failed. Removing from cache and retrying with AI.',
                                    err.message,
                                );
                                delete appSelectorCache[cacheKey];
                                saveCache();
                            }
                        }

                        // If no valid cached selector, ask the AI
                        if (!finalSelector) {
                            let nextSelector;
                            try {
                                const pageSource = await waitForPageStability(
                                    browser,
                                    30000,
                                    1000,
                                );
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
                                    await element.waitForDisplayed({
                                        timeout: 30000,
                                        interval: 2000,
                                    });
                                    console.log('Next step element is now visible.');
                                    const strategy = determineLocatorStrategy(nextSelector);
                                    cacheKey = `${currentPageName} - ${elementName} - ${strategy}`;
                                    appSelectorCache[cacheKey] = nextSelector;
                                    saveCache();
                                    finalSelector = nextSelector;
                                } catch (waitErr) {
                                    console.log(
                                        'Failed waiting for next step element:',
                                        waitErr.message,
                                    );
                                }
                            }
                        }

                        if (!finalSelector) {
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
                if (activeContext === 'webview') {
                    try {
                        await switchToWebview(browser);
                    } catch (err) {
                        console.log(
                            'WEBVIEW context not available, switching to native and updating active context.',
                        );
                        await switchToNative(browser);
                        activeContext = 'native';
                    }
                } else {
                    await switchToNative(browser);
                }
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
                if (activeContext === 'webview') {
                    try {
                        await switchToWebview(browser, 5000);
                    } catch (err) {
                        console.log(
                            'WebView context disappeared, switching to native and updating active context.',
                        );
                        await switchToNative(browser);
                        activeContext = 'native';
                    }
                } else {
                    await switchToNative(browser);
                }
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


module.exports = {
    executeTest,
};
