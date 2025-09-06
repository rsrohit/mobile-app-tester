const test = require('node:test');
const assert = require('node:assert');

process.env.GEMINI_API_KEY = 'dummy';
process.env.DEEPSEEK_API_KEY = 'dummy';

const { executeCommand } = require('../src/test-runner/command_utils');

const contexts = [
    {
        platform: 'android',
        selector: 'com.example:id/login',
        strategy: 'resource-id',
    },
    {
        platform: 'ios',
        selector: '~loginButton',
        strategy: 'accessibility-id',
    },
];

for (const ctx of contexts) {
    test(`executeCommand caches and retrieves selectors on ${ctx.platform}`, async () => {
        const browser = {
            pause: async () => {},
            getPageSource: async () => '<hierarchy />',
        };

        const elementStub = {
            click: async () => {},
            setValue: async () => {},
            waitForExist: async () => {},
        };

        const selectorsUsed = [];
        const findElementFirst = async (sel) => {
            selectorsUsed.push(sel);
            return elementStub;
        };

        const cache = {};
        const originalStep = 'Tap the *Login* button';
        const pageName = 'LoginPage';

        await executeCommand(
            browser,
            { command: 'click', selector: ctx.selector },
            'gemini',
            cache,
            pageName,
            originalStep,
            findElementFirst,
        );

        assert.strictEqual(
            cache[`${pageName} - Login - ${ctx.strategy}`],
            ctx.selector,
        );

        const findElementSecond = async (sel) => {
            selectorsUsed.push(sel);
            if (sel !== ctx.selector) {
                throw new Error('Used wrong selector');
            }
            return elementStub;
        };

        await executeCommand(
            browser,
            { command: 'click', selector: `${ctx.selector}-wrong` },
            'gemini',
            cache,
            pageName,
            originalStep,
            findElementSecond,
        );

        assert.deepStrictEqual(selectorsUsed, [ctx.selector, ctx.selector]);
    });
}

