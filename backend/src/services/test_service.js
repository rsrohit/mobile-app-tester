const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Ensure the test definitions directory exists.  This is called before
 * any operations that read or write tests to guarantee the directory
 * structure is available.  When the directory already exists the call
 * is a no‑op due to the {recursive:true} option.
 */
function ensureTestsDir() {
  fs.mkdirSync(config.testsDir, { recursive: true });
}

/**
 * Parse a JSON file from disk and return a test object.  If the file
 * contents cannot be parsed or the required fields are missing, an
 * error is thrown.  The id is derived from the filename (without
 * extension).
 *
 * @param {string} filePath Absolute path to the JSON file.
 * @returns {object} Test definition with id, name, tags, and steps.
 */
function readJsonTest(filePath) {
  const id = path.basename(filePath, path.extname(filePath));
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse JSON test file ${filePath}: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.steps)) {
    throw new Error(`Invalid test format in ${filePath}: missing steps array`);
  }
  return {
    id,
    name: data.name || id,
    tags: Array.isArray(data.tags) ? data.tags : [],
    steps: data.steps.map((s) => s.toString()),
  };
}

/**
 * Parse a CSV file from disk and return a test object.  The CSV format
 * expects one step per line.  Optionally the first line may contain
 * metadata in JSON form (e.g., {"name":"Login Test","tags":["smoke"]}).
 * If the first line begins with a "{", it will be parsed as JSON
 * metadata; otherwise it is treated as a step.  Tags will be an empty
 * array if not provided.
 *
 * @param {string} filePath Absolute path to the CSV file.
 * @returns {object} Test definition with id, name, tags, and steps.
 */
function readCsvTest(filePath) {
  const id = path.basename(filePath, path.extname(filePath));
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  let name = id;
  let tags = [];
  let steps = [];
  if (lines.length === 0) {
    throw new Error(`CSV test file ${filePath} is empty`);
  }
  const first = lines[0].trim();
  if (first.startsWith('{')) {
    try {
      const meta = JSON.parse(first);
      name = meta.name || name;
      tags = Array.isArray(meta.tags) ? meta.tags : tags;
      steps = lines.slice(1);
    } catch (e) {
      // If parsing fails, treat the first line as a step
      steps = lines;
    }
  } else {
    steps = lines;
  }
  return {
    id,
    name,
    tags,
    steps: steps.map((s) => s.toString()),
  };
}

/**
 * Load all test definitions from the configured tests directory.  Both
 * JSON and CSV files are supported.  Tests that cannot be parsed
 * successfully are skipped with a console warning.
 *
 * @returns {Array<object>} List of test definitions.
 */
function loadAllTests() {
  ensureTestsDir();
  const files = fs.readdirSync(config.testsDir);
  const tests = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const full = path.join(config.testsDir, file);
    try {
      if (ext === '.json') {
        tests.push(readJsonTest(full));
      } else if (ext === '.csv') {
        tests.push(readCsvTest(full));
      }
    } catch (e) {
      console.warn(`Skipping test file ${file}: ${e.message}`);
    }
  }
  return tests;
}

/**
 * Get all tests, optionally filtering by a tag.  The returned tests
 * include only id, name, and tags (steps are omitted for summary).
 *
 * @param {string} [tag] Optional tag to filter tests by.
 * @returns {Array<object>} Array of test summaries.
 */
function getAllTests(tag) {
  const tests = loadAllTests();
  return tests
    .filter((t) => !tag || (t.tags && t.tags.includes(tag)))
    .map(({ id, name, tags }) => ({ id, name, tags }));
}

/**
 * Retrieve a single test definition by its id.  Returns null if not
 * found or unable to parse.
 *
 * @param {string} id Test identifier (filename without extension).
 * @returns {object|null} Test definition with steps or null if not found.
 */
function getTestById(id) {
  ensureTestsDir();
  const jsonPath = path.join(config.testsDir, `${id}.json`);
  const csvPath = path.join(config.testsDir, `${id}.csv`);
  if (fs.existsSync(jsonPath)) {
    try {
      return readJsonTest(jsonPath);
    } catch (e) {
      console.warn(`Error loading test ${id}: ${e.message}`);
      return null;
    }
  }
  if (fs.existsSync(csvPath)) {
    try {
      return readCsvTest(csvPath);
    } catch (e) {
      console.warn(`Error loading test ${id}: ${e.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Save a new test definition to disk.  The test will be assigned a
 * unique identifier based on its name and timestamp.  The saved file
 * will be written as JSON.  Returns the id of the created test.
 *
 * @param {object} test Object with properties name, tags, and steps.
 * @returns {string} The id of the saved test.
 */
function saveTest(test) {
  if (!test || typeof test !== 'object' || !Array.isArray(test.steps)) {
    throw new Error('Invalid test object: must include a steps array');
  }
  ensureTestsDir();
  const name = test.name || 'test';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 50);
  const id = `${slug || 'test'}-${Date.now()}`;
  const fileName = `${id}.json`;
  const filePath = path.join(config.testsDir, fileName);
  const data = {
    name: test.name || id,
    tags: Array.isArray(test.tags) ? test.tags : [],
    steps: test.steps.map((s) => s.toString()),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return id;
}

module.exports = {
  getAllTests,
  getTestById,
  saveTest,
};