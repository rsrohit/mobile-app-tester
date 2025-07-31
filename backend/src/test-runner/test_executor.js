const { remote } = require('webdriverio');
const path = require('path');
const convert = require('xml-js');
// Import the updated NLP service functions
const { translateStepsToCommands, findCorrectSelector } = require('../services/nlp_service');

// Appium server configuration
const appiumOptions = {
    hostname: '127.0.0.1',
    port: 4723,
    logLevel: 'error',
};

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
 * Executes a series of structured commands on an Android device using WebdriverIO and Appium.
 * @param {string} apkPath - The absolute path to the .apk file.
 * @param {string} rawStepsText - The raw natural language steps from the user as a single string.
 * @param {object} io - The Socket.IO instance for emitting real-time updates.
 * @param {string} socketId - The ID of the client's socket connection.
 * @param {string} aiService - The AI service to use ('gemini' or 'deepseek').
 */
async function executeTest(apkPath, rawStepsText, io, socketId, aiService) {
    let browser;
    try {
        const capabilities = {
            'platformName': 'Android',
            'appium:automationName': 'UiAutomator2',
            'appium:deviceName': 'Android Emulator',
            'appium:app': path.resolve(apkPath),
            'appium:noReset': false,
            'appium:autoGrantPermissions': true,
        };

        browser = await remote({ ...appiumOptions, capabilities });

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

            const commandsResponse = await translateStepsToCommands(group.join('\n'), cleanedSource, aiService);
            console.log("Received context-aware commands for group:", commandsResponse);

            // --- FIX: Handle multiple response structures from different AI services ---
            let commands;
            if (Array.isArray(commandsResponse)) {
                commands = commandsResponse; // Handles Gemini's array response
            } else if (commandsResponse.steps && Array.isArray(commandsResponse.steps)) {
                commands = commandsResponse.steps; // Handles Deepseek's nested array response
            } else if (commandsResponse.command) {
                commands = [commandsResponse]; // Handles Deepseek's single object response
            }

            if (!commands) {
                throw new Error(`AI service returned an invalid command structure: ${JSON.stringify(commandsResponse)}`);
            }

            for (const command of commands) {
                stepCounter++;
                const stepNumber = stepCounter;

                io.to(socketId).emit('step-update', { stepNumber, status: 'running' });

                try {
                    await executeCommand(browser, command, aiService);
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
 */
async function executeCommand(browser, command, aiService) {
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

    try {
        console.log(`Executing step: "${command.original_step}" with selector: "${command.selector}"`);
        const element = await findElement(command.selector);
        await element.waitForExist({ timeout: 10000 });
        console.log("Found element successfully.");
        await performAction(element);

    } catch (initialError) {
        console.log("Initial findElement strategy failed. Initiating self-healing protocol.");
        
        try {
            const pageSource = await browser.getPageSource();
            const cleanedSourceForHealing = cleanPageSource(pageSource);
            let newSelector = await findCorrectSelector(command.original_step, cleanedSourceForHealing, aiService);

            // Sanitize the AI's response to remove backticks or quotes
            newSelector = newSelector.replace(/[`"']/g, '');

            console.log(`Self-healing: Retrying step with AI-suggested selector: "${newSelector}"`);
            const healedElement = await findElement(newSelector);
            await healedElement.waitForExist({ timeout: 10000 });
            
            console.log("Successfully found element with AI-healed selector.");
            await performAction(healedElement);

        } catch (healingError) {
            console.error("Self-healing also failed.", healingError);
            throw new Error(`Could not find element for step: "${command.original_step}". Initial error: ${initialError.message}`);
        }
    }

    await browser.pause(1000);
}

module.exports = { executeTest };