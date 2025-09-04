const test = require('node:test');
const assert = require('node:assert');

// Provide dummy AI service keys so requiring test_executor does not throw.
process.env.GEMINI_API_KEY = 'dummy';
process.env.DEEPSEEK_API_KEY = 'dummy';

const { extractElementName, determineLocatorStrategy } = require('./test_executor');

test('extracts element name wrapped in asterisks', () => {
    const step = "Tap the *Login* button";
    assert.strictEqual(extractElementName(step), 'Login');
});

test('returns last word when no delimiters are found', () => {
    const step = "Tap the Login button";
    assert.strictEqual(extractElementName(step), 'button');
});

test('detects accessibility-id strategy', () => {
    assert.strictEqual(determineLocatorStrategy('~foo'), 'accessibility-id');
});

test('detects resource-id strategy', () => {
    assert.strictEqual(determineLocatorStrategy('com.example:id/foo'), 'resource-id');
});

test('detects xpath strategy', () => {
    assert.strictEqual(determineLocatorStrategy('//android.widget.TextView'), 'xpath');
});
