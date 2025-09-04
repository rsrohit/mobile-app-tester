const fs = require('fs');
const path = require('path');

let POM_FILE_PATH = null;
const pomCache = {};

function determineLocatorStrategy(selector = '') {
    if (!selector) return 'unknown';
    if (selector.startsWith('~')) return 'accessibility-id';
    if (selector.includes(':id/') || selector.includes('resource-id')) return 'resource-id';
    if (selector.startsWith('//') || selector.startsWith('(')) return 'xpath';
    return 'unknown';
}

function loadCache(platform = 'android') {
    POM_FILE_PATH = path.join(
        __dirname,
        `../../pom_${platform}.json`,
    );
    try {
        if (fs.existsSync(POM_FILE_PATH)) {
            const data = fs.readFileSync(POM_FILE_PATH, 'utf8');
            const parsed = JSON.parse(data);
            const migratedCache = {};
            let needsMigration = false;
            for (const [key, selector] of Object.entries(parsed)) {
                const parts = key.split(' - ');
                if (parts.length === 2) {
                    const [page, element] = parts;
                    const strategy = determineLocatorStrategy(selector);
                    migratedCache[`${page} - ${element} - ${strategy}`] = selector;
                    needsMigration = true;
                } else {
                    migratedCache[key] = selector;
                }
            }
            Object.keys(pomCache).forEach(key => delete pomCache[key]);
            Object.assign(pomCache, migratedCache);
            if (needsMigration) {
                saveCache();
            }
            console.log(
                `Successfully loaded ${platform} POM cache from ${path.basename(POM_FILE_PATH)}`,
            );
        } else {
            Object.keys(pomCache).forEach(key => delete pomCache[key]);
        }
    } catch (error) {
        console.error(
            `Could not load POM cache from ${path.basename(POM_FILE_PATH)}:`,
            error,
        );
        Object.keys(pomCache).forEach(key => delete pomCache[key]);
    }
}

function saveCache() {
    if (!POM_FILE_PATH) return;
    try {
        fs.writeFileSync(POM_FILE_PATH, JSON.stringify(pomCache, null, 2), 'utf8');
        console.log(`POM cache saved to ${path.basename(POM_FILE_PATH)}`);
    } catch (error) {
        console.error(
            `Could not save POM cache to ${path.basename(POM_FILE_PATH)}:`,
            error,
        );
    }
}

module.exports = {
    loadCache,
    saveCache,
    pomCache,
};

