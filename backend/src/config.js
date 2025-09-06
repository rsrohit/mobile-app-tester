const path = require('path');

// Load environment variables from a `.env` file if present.  This call
// is idempotent and will silently do nothing if no file exists.  By
// requiring dotenv here, we ensure that configuration is available
// throughout the backend without repeating config() calls in every
// module.
require('dotenv').config();

/**
 * Consolidated configuration for the backend.  This module reads
 * environment variables, applies sensible defaults, and exposes a
 * typed configuration object.  Mandatory values (such as AI service
 * keys) are checked on load so misconfiguration fails fast.  Optional
 * variables provide fallbacks when not set.
 */
const config = {};

// Server configuration
config.port = parseInt(process.env.PORT || '3000', 10);

// Resolve the path to the frontend.  The default assumes the
// repository layout from the README: `backend/src` relative to
// `frontend`.  When overriding via environment variables, relative
// values are resolved relative to this config file's directory to
// avoid surprises when the working directory differs.
const defaultFrontend = path.join(__dirname, '../../frontend');
const defaultUploadDir = path.join(__dirname, '../../uploads');
const defaultTestsDir = path.join(__dirname, '../../tests');

function resolveRelativePath(envPath, fallback) {
  if (!envPath) return fallback;
  return path.isAbsolute(envPath) ? envPath : path.resolve(__dirname, envPath);
}

config.frontendPath = resolveRelativePath(process.env.FRONTEND_PATH, defaultFrontend);
config.uploadDir = resolveRelativePath(process.env.UPLOAD_DIR, defaultUploadDir);

// Resolve the path to the directory containing test definitions.  Test
// files (JSON or CSV) stored here will be loaded by the test_service.
config.testsDir = resolveRelativePath(process.env.TESTS_DIR, defaultTestsDir);

// Maximum upload size (in megabytes).  Values from process.env are
// coerced to integers; invalid values fall back to 50MB.
config.maxUploadMb = (() => {
  //const raw = process.env.MAX_UPLOAD_MB;
  const raw = 100; // default to 100MB
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
})();

// Allowed CORS origins.  Accept a comma-separated list or "*" for
// permissive mode.  Defaults to '*'.
config.allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

// Should uploaded APKs be cleaned up when a test completes?  Accept
// 'true' or 'false' strings; any other value is treated as true.
config.cleanUploadsAfterTest = (process.env.CLEAN_UPLOADS_AFTER_TEST || 'true').toLowerCase() === 'false';

// AI service keys.  These are required for the NLP service to run.
config.geminiApiKey = process.env.GEMINI_API_KEY;
config.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
if (!config.geminiApiKey || !config.deepseekApiKey) {
  throw new Error(
    'Missing AI service API keys. Please set GEMINI_API_KEY and DEEPSEEK_API_KEY in your environment.',
  );
}

// BrowserStack credentials.  These are optional; tests using
// BrowserStack will throw explicit errors if missing.
config.browserStackUsername = process.env.BROWSERSTACK_USERNAME;
config.browserStackAccessKey = process.env.BROWSERSTACK_ACCESS_KEY;

module.exports = config;