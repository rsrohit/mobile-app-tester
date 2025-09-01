const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/**
 * Environment variables are loaded once in src/config.js.  Avoid
 * calling dotenv here to prevent duplicate parsing and side effects.
 */

// --- API Keys and URLs ---
// Import our central config.  This will load environment variables and
// validate that GEMINI_API_KEY and DEEPSEEK_API_KEY are present.  By
// using config here we avoid reloading dotenv and duplicating checks.
const config = require('../config');

const GEMINI_API_KEY = config.geminiApiKey;
const DEEPSEEK_API_KEY = config.deepseekApiKey;

// Construct API URLs once using the keys from config
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * Translates a string of natural language test steps into a structured
 * JSON array of commands using the selected AI service.
 * @param {string} rawSteps - The user-provided test steps.
 * @param {string} pageSource - The initial XML page source from the app.
 * @param {string} aiService - The selected AI service ('gemini' or 'deepseek').
 * @returns {Promise<any[]>} A promise that resolves to an array of command objects.
 */
async function translateStepsToCommands(rawSteps, pageSource, aiService) {
    const prompt = `
        You are an expert test automation assistant. Your task is to convert a list of user-provided, natural language test steps into a structured JSON array.
        Use the provided XML page source as the primary context to determine the most accurate and reliable selectors for each element for the entire test flow.

        The JSON objects must have the following properties:
        - "command": (String) The action to perform. Supported commands are: "click", "setValue", "verifyVisible", "launchApp".
        - "selector": (String) The best selector for the target UI element based on the XML source. Prefer accessibility IDs.
          * For **Android**, prioritize 'resource-id', then 'content-desc'.
          * For **iOS**, prioritize the element's 'name' or 'label' attributes.
          * When using an accessibility identifier, prefix the selector with '~'.
          * Use a precise XPath only if no stable accessibility identifier or resource-id is available.
        - "value": (String) The text to be entered into a field.
        - "original_step": (String) The original, unmodified natural language step.

        CONTEXT:
        ---
        **Initial Page XML Source:**
        \`\`\`xml
        ${pageSource}
        \`\`\`
        ---

        Now, based on the XML source above, please convert the following user-provided steps into the specified JSON format. Do not include any explanations, just the raw JSON array.

        **User Steps:**
        ---
        ${rawSteps}
        ---
    `;

    if (aiService === 'deepseek') {
        return callDeepseek(prompt, 'translate');
    }
    // Default to Gemini
    return callGemini(prompt, 'translate');
}

/**
 * Asks the AI to identify a stable element to wait for to confirm a page has loaded.
 * @param {string} pageName - The name of the page we are waiting for (e.g., "home").
 * @param {string} pageSource - The current XML page source.
 * @param {string} aiService - The selected AI service.
 * @returns {Promise<string>} A promise that resolves to the selector of a stable element.
 */
async function getPageLoadIndicator(pageName, pageSource, aiService) {
    console.log(`Asking ${aiService} for a stable element to verify the "${pageName}" page has loaded...`);
    const prompt = `
        You are an expert Appium test automation engineer. The test is waiting for the "${pageName}" page to load.
        Analyze the provided XML page source and identify the single, most reliable selector for a stable element that is always present on the "${pageName}" page (e.g., a title, a navigation bar, or a main layout).

        Prefer stable accessibility identifiers when choosing a selector.
        - On **Android**, look for 'resource-id' first and then 'content-desc'.
        - On **iOS**, prefer the element's 'name' or 'label' attributes.
        Prefix accessibility identifiers with '~'.

        **XML Page Source:**
        \`\`\`xml
        ${pageSource}
        \`\`\`

        Return only the single best selector string, with no explanation.
    `;
    
    // For this task, Gemini is generally more reliable. We'll use it regardless of the user's choice for translation.
    return callGemini(prompt, 'heal'); // 'heal' task just returns the raw text response.
}

/**
 * Calls the Gemini API with a given prompt.
 * @param {string} prompt - The prompt to send to the API.
 * @param {string} task - The type of task ('translate' or 'heal').
 */
async function callGemini(prompt, task) {
    console.log('Sending request to Gemini API...');
    const payload = { contents: [{ parts: [{ text: prompt }] }] };
    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini API request failed with status ${response.status}: ${errorBody}`);
        }
        const data = await response.json();
        const rawJson = data.candidates[0].content.parts[0].text;
        
        if (task === 'translate') {
             const cleanedJson = rawJson.replace(/```json\n|```/g, '').trim();
             return JSON.parse(cleanedJson);
        }
        // For self-healing or getting an indicator, just return the raw text
        return rawJson.trim();

    } catch (error) {
        console.error('Error calling Gemini API:', error);
        throw new Error('Failed to get a valid response from the Gemini service.');
    }
}

/**
 * Calls the Deepseek API with a given prompt.
 * @param {string} prompt - The prompt to send to the API.
 * @param {string} task - The type of task ('translate' or 'heal').
 */
async function callDeepseek(prompt, task) {
    console.log('Sending request to Deepseek API...');
    const payload = {
        model: 'deepseek-chat',
        messages: [
            { role: 'system', content: 'You are an expert test automation assistant that only responds with raw JSON.' },
            { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
    };
    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Deepseek API request failed with status ${response.status}: ${errorBody}`);
        }
        const data = await response.json();
        const rawJson = data.choices[0].message.content;
        return JSON.parse(rawJson);
    } catch (error) {
        console.error('Error calling Deepseek API:', error);
        throw new Error('Failed to get a valid response from the Deepseek service.');
    }
}

/**
 * Analyzes the raw XML page source to find the best selector for a failed step.
 * @param {string} originalStep - The natural language step that failed.
 * @param {string} pageSource - The raw XML source of the screen from Appium.
 * @param {string} aiService - The selected AI service ('gemini' or 'deepseek').
 * @returns {Promise<string>} A promise that resolves to the single best selector string.
 */
async function findCorrectSelector(originalStep, pageSource, aiService) {
    console.log(`Asking ${aiService} for help with the page source...`);

    const prompt = `
        You are an expert Appium test automation engineer. A test step has failed because the element could not be found. Your task is to analyze the provided XML page source and identify the single best selector for the element described in the original step.

        Prioritize selectors in this order:
        1. **resource-id** (Android) or **name/label** (iOS) if unique and descriptive
        2. **content-desc** (Android accessibility ID) or **name/label** (iOS)
        3. **A precise XPath**

        Prefix accessibility identifiers with '~' in the selector string.

        Here is the context:

        **Original Failed Step:** "${originalStep}"

        **XML Page Source:**
        \`\`\`xml
        ${pageSource}
        \`\`\`

        Based on the XML, what is the single, most reliable selector string to find the element for the failed step? Return only the selector string itself, with no explanation.
    `;

    if (aiService === 'deepseek') {
        const payload = {
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: 'You are an expert Appium engineer. Find the best selector from the provided XML and return only the selector string.' },
                { role: 'user', content: prompt },
            ],
        };
        try {
            const response = await fetch(DEEPSEEK_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(`Deepseek API request failed with status ${response.status}`);
            }
            const data = await response.json();
            return data.choices[0].message.content.trim();
        } catch (error) {
            console.error('Error calling Deepseek API for self-healing:', error);
            throw new Error('The Deepseek service could not find a corrected selector.');
        }
    }

    // Default to Gemini for self-healing
    return callGemini(prompt, 'heal');
}

module.exports = {
    translateStepsToCommands,
    findCorrectSelector,
    getPageLoadIndicator, // Export the new function
};