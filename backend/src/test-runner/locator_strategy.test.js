const test = require('node:test');
const assert = require('node:assert');

process.env.GEMINI_API_KEY = 'dummy';
process.env.DEEPSEEK_API_KEY = 'dummy';

const { determineLocatorStrategy } = require('./test_executor');

test('detects accessibility-id strategy', () => {
    assert.strictEqual(determineLocatorStrategy('~foo'), 'accessibility-id');
});

test('detects resource-id strategy', () => {
    assert.strictEqual(determineLocatorStrategy('com.example:id/foo'), 'resource-id');
});

test('detects xpath strategy', () => {
    assert.strictEqual(determineLocatorStrategy('//android.widget.TextView'), 'xpath');
});

