const test = require('node:test');
const assert = require('node:assert');

// Provide dummy AI service keys so requiring test_executor does not throw.
process.env.GEMINI_API_KEY = 'dummy';
process.env.DEEPSEEK_API_KEY = 'dummy';

const { extractElementName } = require('./test_executor');

test('extracts element name wrapped in asterisks', () => {
    const step = "Tap the *Login* button";
    assert.strictEqual(extractElementName(step), '*Login*');
});

test('extracts element name wrapped in single quotes', () => {
    const step = "Tap the 'Login' button";
    assert.strictEqual(extractElementName(step), "'Login'");
});
