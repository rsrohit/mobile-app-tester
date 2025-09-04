# Mobile App Tester

An intelligent, AI-powered tool for automating mobile application testing. This project allows team members to write test steps in plain English, upload an `.apk` or `.ipa` file, and receive real-time results as the AI translates the steps into executable actions on an Android or iOS emulator or device.

---

## Features

-   **Natural Language Processing (NLP):** Write test steps in simple, everyday English.
-   **Multi-AI Support:** Choose between **Gemini** and **Deepseek** to translate your test steps, providing flexibility and avoiding rate limits.
-   **Context-Aware Selector Generation:** The tool analyzes the app's current screen layout (XML source) to generate the most accurate and reliable element selectors.
-   **Page-Aware Test Execution:** Intelligently groups test steps by page, refreshing its context after page transitions to ensure accuracy.
-   **Self-Healing Tests:** If an element isn't found, the tool automatically uses the AI and the current page source to find the correct selector and retry the step.
-   **Real-time Web Interface:** A clean, modern UI provides live feedback on each step of the test execution.
-   **Android and iOS app testing support**

---

## Technology Stack

-   **Backend:** Node.js, Express.js
-   **Test Automation:** Appium, WebdriverIO
-   **Real-time Communication:** Socket.IO
-   **AI Services:** Google Gemini, Deepseek
-   **Frontend:** HTML, Tailwind CSS

---

## Project Structure

```

/mobile-app-tester
|
|-- 📂 backend/
|   |-- 📂 src/
|   |   |-- 📂 api/
|   |   |   |-- routes.js
|   |   |-- 📂 services/
|   |   |   |-- nlp\_service.js
|   |   |-- 📂 test-runner/
|   |   |   |-- test\_executor.js
|   |   |-- app.js
|   |-- package.json
|   |-- pom_android.json
|   |-- pom_ios.json
|
|-- 📂 frontend/
|   |-- index.html
|
|-- 📂 └── tests
|   |-- sample_login.json
|
|-- 📂 uploads/
|
|-- README.md

````

---

## Setup and Installation

Follow these steps to set up the project on your local machine.

### 1. Prerequisites

Make sure you have the following software installed:

-   **Node.js and npm:** [Download Node.js](https://nodejs.org/)
-   **Java Development Kit (JDK):** Required by Appium.
-   **Android Studio:** For the Android SDK and emulator. [Download Android Studio](https://developer.android.com/studio)

### 2. Environment Setup

1.  **Install Android SDK Command-line Tools:**
    -   Open Android Studio > Settings > Appearance & Behavior > System Settings > Android SDK.
    -   Go to the **SDK Tools** tab and check the box for **"Android SDK Command-line Tools (latest)"**.
    -   Click **Apply** to install.

2.  **Configure Environment Variables:**
    -   You need to set `ANDROID_HOME` and `JAVA_HOME` variables. Open your shell configuration file (e.g., `~/.zshrc`, `~/.bash_profile`).
    -   Add the following lines, replacing the paths with your actual installation locations:
        ```bash
        # Android SDK
        export ANDROID_HOME=/path/to/your/Android/sdk
        export PATH=$PATH:$ANDROID_HOME/tools:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin

        # Java JDK
        export JAVA_HOME=/path/to/your/jdk
        export PATH=$JAVA_HOME/bin:$PATH
        ```
    -   Save the file and restart your terminal.

### 3. Appium Setup

1.  **Install Appium Server:**
    ```bash
    npm install -g appium
    ```
2.  **Install the UiAutomator2 Driver:**
    ```bash
    appium driver install uiautomator2
    ```
3.  **Verify Setup (Optional):**
    ```bash
    npm install -g appium-doctor
    appium-doctor --android
    ```

### 4. Project Installation

1.  **Clone the Repository:**
    ```bash
    git clone <your-repository-url>
    cd mobile-app-tester
    ```
2.  **Install Backend Dependencies:**
    -   Navigate to the `backend` directory.
    -   Run `npm install` to download all required packages.
        ```bash
        cd backend
        npm install
        ```

---

## Configuration

Before running the application, set your AI service keys via environment variables.  The backend reads `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` from the environment, and `backend/src/config.js` will exit with an error if either key is missing.

Example (bash):

```bash
export GEMINI_API_KEY="your-gemini-key"
export DEEPSEEK_API_KEY="your-deepseek-key"
```

You can also place these values in a `.env` file in the `backend` directory.

-----

## How to Use

1.  **Start an Android Emulator:**

      - Open Android Studio \> Tools \> Device Manager.
      - Launch your desired virtual device.

2.  **Start the Appium Server:**

      - Open a new terminal window.
      - Run the command: `appium`

3.  **Start the Backend Server:**

      - Open another new terminal window.
      - Navigate to the `backend` directory.
      - Run the command: `npm start`

4.  **Open the Web Interface:**

      - Open your web browser and go to **http://localhost:3000**.
      - Select your desired AI service.
      - Upload your `.apk` file.
      - nter your test steps in plain English. When referencing UI elements, enclose the element name in `*` (for example, `Tap on *Login* button`).
      - Click **"Run Test"** and watch the magic happen\!

-----

## Writing Test Steps and Page Objects

### Element Names in Steps

When describing an action on a specific element, wrap the element name in asterisks so the parser can easily extract it:

- `Tap on *Login* button`
- `Enter valid username into *Email* field`

### POM Key Format

Selectors cached by the system are stored in `pom_android.json` and `pom_ios.json` with keys using the format:

```
page - element - strategy
```

Examples:

```json
{
  "login - Email - resource-id": "au.com.bws.debug:id/emailEditText",
  "login - Password - accessibility-id": "~Password"
}
```

### Supported Locator Strategies

The strategy portion of the key tells the engine how to locate the element. The following strategies are currently supported:

- `resource-id` – Android resource ids like `au.com.bws.debug:id/loginBtn`
- `accessibility-id` – iOS accessibility ids or Android content-descriptions prefixed with `~`
- `xpath` – XPath expressions beginning with `//` or `(`

These strategies appear at the end of each key, letting testers know what to expect in the POM files.

-----

## Resource Links

  - [Appium Documentation](http://appium.io/)
  - [WebdriverIO Documentation](https://webdriver.io/)
  - [Google Gemini API](https://ai.google.dev/gemini-api)
  - [Deepseek API](https://www.deepseek.com/)
