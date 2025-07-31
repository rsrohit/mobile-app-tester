const { remote } = require('webdriverio');
const path = require('path');
const convert = require('xml-js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');
const FormData = require('form-data');
// Import the updated NLP service functions
const { translateStepsToCommands, findCorrectSelector } = require('../services/nlp_service');

// --- BrowserStack Credentials ---
// It's best to use environment variables for these in a real project
const BROWSERSTACK_USERNAME = "rohitshinde_YwW1dy";
const BROWSERSTACK_ACCESS_KEY = "xxezZxByKhdTgTXmrMMh";


// --- POM Caching Logic with File Persistence ---
const POM_FILE_PATH = path.join(__dirname, '../../pom.json');
let pomCache = {};

// Load the entire multi-app cache from the file system on startup
try {
    if (fs.existsSync(POM_FILE_PATH)) {
        const data = fs.readFileSync(POM_FILE_PATH, 'utf8');
        pomCache = JSON.parse(data);
        console.log("Successfully loaded multi-app POM cache from pom.json");
    }
} catch (error) {
    console.error("Could not load POM cache from pom.json:", error);
    pomCache = {}; // Start with an empty cache if loading fails
}

/**
 * Saves the current state of the entire POM cache to the pom.json file.
 */
function saveCache() {
    try {
        fs.writeFileSync(POM_FILE_PATH, JSON.stringify(pomCache, null, 2), 'utf8');
        console.log("POM cache saved to pom.json");
    } catch (error) {
        console.error("Could not save POM cache to pom.json:", error);
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
            const attributesToKeep = ['class', 'resource-id', 'content-desc', 'text', 'package', 'checkable', 'checked', 'clickable', 'enabled', 'selected'];
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
        console.error("Failed to clean XML page source, returning original.", error);
        return xml; // Fallback to the original XML if cleaning fails
    }
}

/**
 * Uploads an APK to BrowserStack and returns the app_url.
 * @param {string} apkPath - The local path to the .apk file.
 * @returns {Promise<string>} The app_url from BrowserStack.
 */
async function uploadToBrowserStack(apkPath) {
    console.log("Uploading APK to BrowserStack...");
    
    const form = new FormData();
    form.append('file', fs.createReadStream(apkPath));

    const response = await fetch('https://api-cloud.browserstack.com/app-automate/upload', {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(`${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}`).toString('base64'),
        },
        body: form,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`BrowserStack upload failed: ${errorBody}`);
    }

    const data = await response.json();
    console.log("BrowserStack upload successful. App URL:", data.app_url);
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
async function executeTest(apkPath, rawStepsText, io, socketId, aiService, testEnvironment) {
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
                    'userName': BROWSERSTACK_USERNAME,
                    'accessKey': BROWSERSTACK_ACCESS_KEY,
                    'deviceName': 'Samsung Galaxy S23', // Example device
                    'platformVersion': '13.0',
                    'projectName': 'AI Mobile Tester',
                    'buildName': `Build-${Date.now()}`,
                    'debug': true,
                    'networkLogs': true,
                },
                'platformName': 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:app': app_url,
            };
        } else {
            // Default to local execution
            appiumOptions = {
                hostname: '127.0.0.1',
                port: 4723,
                logLevel: 'error',
            };
            capabilities = {
                'platformName': 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:deviceName': 'Android Emulator',
                'appium:app': path.resolve(apkPath),
                'appium:noReset': false,
                'appium:autoGrantPermissions': true,
            };
        }

        console.log("Attempting to start remote session...");
        browser = await remote({ ...appiumOptions, capabilities });
        console.log("Remote session started successfully.");

        // --- NEW: Identify the app and prepare its specific cache ---
        const appPackage = browser.capabilities.appPackage;
        console.log(`Identified app package: ${appPackage}`);
        if (!pomCache[appPackage]) {
            console.log(`No existing cache found for ${appPackage}. Creating a new one.`);
            pomCache[appPackage] = {};
        }
        const appSelectorCache = pomCache[appPackage];


        // --- PAGE-AWARE GROUPING LOGIC ---
        console.log("Starting page-aware grouped test execution...");
        
        const allSteps = rawStepsText.split('\n').filter(s => s.trim() !== '');
        let stepGroups = [];
        let currentGroup = [];

        // Group steps by "Wait for..." commands
        allSteps.forEach(step => {
            // The "launch" step is always its own group to start
            if (step.toLowerCase().includes('launch the app')) {
                 if (currentGroup.length > 0) {
                    stepGroups.push(currentGroup);
                }
                stepGroups.push([step]);
                currentGroup = [];
            } else if (step.toLowerCase().includes('wait for app to load')) {
                if (currentGroup.length > 0) {
                    stepGroups.push(currentGroup);
                }
                stepGroups.push([step]); // The "wait" step is its own group
                currentGroup = [];
            } else {
                currentGroup.push(step);
            }
        });
        if (currentGroup.length > 0) {
            stepGroups.push(currentGroup);
        }

        let stepCounter = 0;
        for (const group of stepGroups) {
            console.log(`--- Executing Group: "${group.join(', ')}" using ${aiService} ---`);
            
            // Get fresh page source for the new group
            await browser.pause(2000); // Wait for any transitions
            const pageSource = await browser.getPageSource();
            const cleanedSource = cleanPageSource(pageSource);

            const commands = await translateStepsToCommands(group.join('\n'), cleanedSource, aiService);
            console.log("Received context-aware commands for group:", commands);

            for (const command of commands) {
                stepCounter++;
                const stepNumber = stepCounter;

                io.to(socketId).emit('step-update', { stepNumber, status: 'running' });

                try {
                    // Pass the app-specific cache to the command executor
                    await executeCommand(browser, command, aiService, appSelectorCache);
                    io.to(socketId).emit('step-update', { stepNumber, status: 'passed' });
                } catch (stepError) {
                    console.error(`Error on step ${stepNumber}:`, stepError.message);
                    io.to(socketId).emit('step-update', {
                        stepNumber,
                        status: 'failed',
                        details: { error: stepError.message }
                    });
                    throw new Error(`Test failed at step ${stepNumber}: ${command.original_step}`);
                }
            }
        }

        console.log("Test execution completed successfully.");
        io.to(socketId).emit('test-complete', { message: 'Test finished successfully!' });

    } catch (error) {
        console.error("An error occurred during the test execution:", error);
        io.to(socketId).emit('test-error', { message: error.message || 'A critical error occurred in the test executor.' });
    } finally {
        if (browser) {
            await browser.deleteSession();
        }
    }
}

/**
 * Helper function to execute a single command with robust selector strategies and self-healing.
 * @param {object} browser - The WebdriverIO browser instance.
 * @param {object} command - The command object to execute.
 * @param {string} aiService - The AI service to use for self-healing.
 * @param {object} appSelectorCache - The selector cache for the specific app being tested.
 */
async function executeCommand(browser, command, aiService, appSelectorCache) {
    if (command.command === 'launchApp') {
        await browser.pause(2000);
        return;
    }

    // Gracefully handle steps that are just for waiting
    if (command.command === 'verifyVisible' && !command.selector) {
        console.log(`Step "${command.original_step}" has no selector. Treating as a wait/pause.`);
        await browser.pause(2000); // Pause for 2 seconds
        return;
    }

    const performAction = async (element) => {
        if (command.command === 'click') {
            await element.click();
        } else if (command.command === 'setValue') {
            await element.setValue(command.value);
        }
    };

    const findElement = async (selector) => {
        if (!selector) throw new Error("Selector from AI is null or undefined.");
        
        // --- FIX: Add logic to correctly parse "resource-id=" selectors from the AI ---
        if (selector.toLowerCase().startsWith('resource-id=')) {
            const resourceId = selector.substring(12); // Get the part after "resource-id="
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
        console.log(`Attempting to find by flexible XPath for text: "${selector}"`);
        const xpathSelector = `//*[contains(translate(@text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${selector.toLowerCase()}") or contains(translate(@content-desc, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${selector.toLowerCase()}")]`;
        return await browser.$(xpathSelector);
    };

    // --- POM Caching Logic ---
    const cacheKey = command.original_step;
    let element;
    let usedCachedSelector = false;

    // 1. Try to find the element using a cached selector first
    if (appSelectorCache[cacheKey]) {
        try {
            console.log(`Found cached selector for step "${cacheKey}": "${appSelectorCache[cacheKey]}"`);
            element = await findElement(appSelectorCache[cacheKey]);
            await element.waitForExist({ timeout: 5000 }); // Use a shorter timeout for cached selectors
            console.log("Successfully found element using cached selector.");
            usedCachedSelector = true;
        } catch (e) {
            console.log("Cached selector failed. Proceeding with AI-provided selector.");
            delete appSelectorCache[cacheKey]; // Remove the invalid selector from the cache
            saveCache(); // Update the JSON file
        }
    }

    // 2. If the cache wasn't used or failed, use the AI-provided selector and self-healing
    if (!usedCachedSelector) {
        try {
            console.log(`Executing step: "${command.original_step}" with selector: "${command.selector}"`);
            element = await findElement(command.selector);
            await element.waitForExist({ timeout: 10000 });
            console.log("Found element successfully with AI-provided selector.");
            appSelectorCache[cacheKey] = command.selector; // Cache the successful selector
            saveCache(); // Update the JSON file

        } catch (initialError) {
            console.log("Initial findElement strategy failed. Initiating self-healing protocol.");
            
            try {
                const pageSource = await browser.getPageSource();
                const cleanedSourceForHealing = cleanPageSource(pageSource);
                let newSelector = await findCorrectSelector(command.original_step, cleanedSourceForHealing, aiService);

                newSelector = newSelector.replace(/[`"']/g, '');

                console.log(`Self-healing: Retrying step with AI-suggested selector: "${newSelector}"`);
                element = await findElement(newSelector);
                await element.waitForExist({ timeout: 10000 });
                
                console.log("Successfully found element with AI-healed selector.");
                appSelectorCache[cacheKey] = newSelector; // Cache the successful healed selector
                saveCache(); // Update the JSON file

            } catch (healingError) {
                console.error("Self-healing also failed.", healingError);
                throw new Error(`Could not find element for step: "${command.original_step}". Initial error: ${initialError.message}`);
            }
        }
    }

    // 3. Perform the action on the found element
    await performAction(element);
    await browser.pause(1000);
}

module.exports = { executeTest };