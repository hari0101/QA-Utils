import {
  Reporter,
  FullResult,
  TestResult,
  TestCase,
  TestStep,
  FullConfig,
  Suite,
} from "@playwright/test/reporter";
import * as fs from "fs";
import * as path from "path";

// Define the structure of our custom report data
interface ReportData {
  config: FullConfig;
  projectName: string;
  reportTitle: string;
  counts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
  };
  tests: {
    title: string;
    fullTitle: string;
    projectName: string;
    status: TestResult["status"];
    duration: number;
    errors: string[];
    retries: number;
    attachments: {
      name: string;
      contentType: string;
      path: string; // Will hold either a relative path or a Base64 Data URL
    }[];
    steps: {
      title: string;
      status: "passed" | "failed" | "skipped" | "timedOut";
      duration: number;
      error?: string;
      steps?: ReportData["tests"][0]["steps"]; // Nested steps
    }[];
  }[];
  startTime: string;
  endTime: string;
  duration: number;
}

// Define reporter options
interface MyCustomReporterOptions {
  outputFolder?: string;
  reportFileName?: string;
  inlineCss?: boolean;
  embedAssets?: boolean; // *** NEW OPTION ***
  applicationName?: string;
  applicationLogoPath?: string;
  footerText?: string;
  reportTitle?: string;
  qaLead?: string;
  executionType?: string;
}

// Define structure for grouped tests
type GroupedTests = Map<string, ReportData["tests"]>;

class MyCustomReporter implements Reporter {
  private reportData: ReportData = {
    config: {} as FullConfig,
    projectName: "",
    reportTitle: "Test Execution Report",
    counts: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
    },
    tests: [],
    startTime: "",
    endTime: "",
    duration: 0,
  };

  private options: Required<MyCustomReporterOptions>;
  private outputDir: string = "";
  private attachmentsDir: string = "";
  private logoDestinationPath: string | undefined;
  private testMap = new Map<
    string,
    {
      test: TestCase;
      results: {
        result: TestResult;
        attachments: ReportData["tests"][0]["attachments"];
      }[];
    }
  >();

  constructor(options?: MyCustomReporterOptions) {
    this.options = {
      outputFolder: options?.outputFolder || "playwright-custom-report",
      reportFileName: options?.reportFileName || "index.html",
      inlineCss: options?.inlineCss ?? true, // Default to true for better portability
      embedAssets: options?.embedAssets ?? false, // *** NEW OPTION INITIALIZED ***
      applicationName: options?.applicationName || "Test Suite",
      applicationLogoPath: options?.applicationLogoPath || "",
      footerText: options?.footerText || "Internal QA-CoE",
      reportTitle: options?.reportTitle || "Failure Analysis Report",
      qaLead: options?.qaLead || "Hari Prasath S",
      executionType: options?.executionType || "N/A",
    };

    // If embedding assets, CSS must also be inlined.
    if (this.options.embedAssets) {
      this.options.inlineCss = true;
    }

    this.reportData.reportTitle = this.options.reportTitle;
  }

  private stripAnsiCodes(str: string): string {
    return str.replace(/\u001b\[(?:\d{1,3}(?:;\d{1,3})*)?[m|K]/g, "");
  }

  // *** NEW HELPER FUNCTION TO ENCODE ASSETS ***
  private getAssetData(attachment: TestResult["attachments"][0]): string {
    if (attachment.path && fs.existsSync(attachment.path)) {
      const fileBuffer = fs.readFileSync(attachment.path);
      return `data:${attachment.contentType};base64,${fileBuffer.toString(
        "base64"
      )}`;
    } else if (attachment.body) {
      return `data:${attachment.contentType};base64,${attachment.body.toString(
        "base64"
      )}`;
    }
    return "";
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.reportData.config = config;
    const dateOptions = {
      timeZone: "Asia/Kolkata",
      month: "long",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    } as const;
    this.reportData.startTime = new Date().toLocaleString("en-US", dateOptions);
    this.outputDir = path.resolve(process.cwd(), this.options.outputFolder);

    // Only create directories if we are NOT embedding assets
    if (!this.options.embedAssets) {
      this.attachmentsDir = path.join(this.outputDir, "attachments");
      if (!fs.existsSync(this.outputDir))
        fs.mkdirSync(this.outputDir, { recursive: true });
      if (!fs.existsSync(this.attachmentsDir))
        fs.mkdirSync(this.attachmentsDir, { recursive: true });
    }

    if (
      this.options.applicationLogoPath &&
      fs.existsSync(this.options.applicationLogoPath)
    ) {
      if (this.options.embedAssets) {
        const logoBuffer = fs.readFileSync(this.options.applicationLogoPath);
        const mimeType =
          "image/" + path.extname(this.options.applicationLogoPath).slice(1);
        this.logoDestinationPath = `data:${mimeType};base64,${logoBuffer.toString(
          "base64"
        )}`;
      } else {
        const logoFileName = path.basename(this.options.applicationLogoPath);
        this.logoDestinationPath = path.join(this.outputDir, logoFileName);
        fs.copyFileSync(
          this.options.applicationLogoPath,
          this.logoDestinationPath
        );
      }
    }
  }

  // *** MODIFIED onTestEnd LOGIC ***
  onTestEnd(test: TestCase, result: TestResult) {
    const processedAttachments = result.attachments.map((attachment) => {
      if (this.options.embedAssets) {
        return {
          name: attachment.name,
          contentType: attachment.contentType || "application/octet-stream",
          path: this.getAssetData(attachment), // Path is now the Base64 Data URL
        };
      } else {
        const attachmentFileName = `${test.id}-${attachment.name}-${
          result.retry
        }-${Date.now()}.${attachment.contentType?.split("/")[1] || "bin"}`;
        const destinationPath = path.join(
          this.attachmentsDir,
          attachmentFileName
        );
        const relativePath = path.join("attachments", attachmentFileName);

        if (attachment.path && fs.existsSync(attachment.path))
          fs.copyFileSync(attachment.path, destinationPath);
        else if (attachment.body)
          fs.writeFileSync(destinationPath, attachment.body);

        return {
          name: attachment.name,
          contentType: attachment.contentType || "application/octet-stream",
          path: relativePath,
        };
      }
    });

    let entry = this.testMap.get(test.id);
    if (!entry) {
      entry = { test, results: [] };
      this.testMap.set(test.id, entry);
    }
    entry.results.push({ result, attachments: processedAttachments });
  }

  private processSteps(steps: TestStep[]): ReportData["tests"][0]["steps"] {
    return steps.map((step) => ({
      title: this.stripAnsiCodes(step.title),
      status: step.error ? "failed" : ("passed" as const),
      duration: step.duration,
      error: step.error
        ? this.stripAnsiCodes(step.error.message || "")
        : undefined,
      steps:
        step.steps && step.steps.length > 0
          ? this.processSteps(step.steps)
          : undefined,
    }));
  }

  onEnd(result: FullResult) {
    // ... (rest of onEnd logic is the same, no changes needed here)

    // ... onEnd LOGIC CONTINUES...
    const dateOptions = {
      timeZone: "Asia/Kolkata",
      month: "long",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    } as const;
    this.reportData.endTime = new Date().toLocaleString("en-US", dateOptions);
    this.reportData.duration = result.duration;

    const allTests: ReportData["tests"] = [];

    this.testMap.forEach((entry) => {
      const final = entry.results[entry.results.length - 1];
      const originalStatus = final.result.status;

      let countStatus: string = originalStatus;
      if (originalStatus === "timedOut" || originalStatus === "interrupted") {
        countStatus = "failed";
      }

      this.reportData.counts.total++;

      if (
        countStatus === "passed" ||
        countStatus === "failed" ||
        countStatus === "skipped"
      ) {
        this.reportData.counts[countStatus]++;
      }

      if (entry.results.length > 1) this.reportData.counts.flaky++;

      const allErrors = entry.results
        .flatMap(({ result: res }) =>
          res.errors.map((err) => this.stripAnsiCodes(err.message || ""))
        )
        .filter(Boolean);

      const allAttachments = entry.results.flatMap(
        ({ attachments }) => attachments
      );
      const steps = this.processSteps(final.result.steps);

      allTests.push({
        title: entry.test.title,
        fullTitle: entry.test.titlePath().slice(1).join(" > "),
        projectName: entry.test.parent.project()?.name || "No Project",
        status: originalStatus,
        duration: final.result.duration,
        errors: allErrors,
        retries: entry.results.length - 1,
        attachments: allAttachments,
        steps,
      });
    });

    this.reportData.tests = allTests;

    const groupedTests: GroupedTests = new Map();
    allTests.forEach((test) => {
      const fullPath = test.fullTitle.split(" > ")[0] || "Unknown File";
      const fileName = path.basename(fullPath);
      const groupKey = `Project Name: ${test.projectName}`;

      if (!groupedTests.has(groupKey)) {
        groupedTests.set(groupKey, []);
      }
      groupedTests.get(groupKey)?.push(test);
    });

    // Do not write separate data file if embedding
    if (!this.options.embedAssets) {
      fs.writeFileSync(
        path.join(this.outputDir, "custom-report-data.json"),
        JSON.stringify(this.reportData, null, 2)
      );
    }
    this.generateHtmlReport(this.reportData, groupedTests);
  }

  // *** MODIFIED generateHtmlReport ***
  private generateHtmlReport(data: ReportData, groupedTests: GroupedTests) {
    const cssContent = this.options.inlineCss ? this.getCssContent() : "";
    const htmlContent = this.createHtmlContent(data, groupedTests, cssContent);

    const outputFilePath = this.options.embedAssets
      ? path.resolve(this.options.outputFolder, this.options.reportFileName)
      : path.join(this.outputDir, this.options.reportFileName);

    // Ensure the output directory exists for single-file mode too
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });

    fs.writeFileSync(outputFilePath, htmlContent);

    if (!this.options.inlineCss && !this.options.embedAssets) {
      fs.writeFileSync(
        path.join(this.outputDir, "style.css"),
        this.getCssContent()
      );
    }
  }

  private getCssContent(): string {
    return `
      @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Poppins:wght@500;600&display=swap');
      :root {
        --primary: #007BFF; --success: #28a745; --danger: #dc3545; --timedOut: #ffc107; --skipped: #6c757d; --flaky: #fd7e14; --light: #f8f9fa; --border: #dee2e6; --sidebar-bg: #ffffff; --card-bg: #ffffff; --shadow: 0 4px 12px rgba(0,0,0,0.05); --transition: all 0.3s ease; --text-color: #212529; --secondary-text-color: #6c757d;
      }
      .dark-theme {
        --primary: #8BE9FD; --success: #50FA7B; --danger: #FF5555; --timedOut: #F1FA8C; --skipped: #6272A4; --flaky: #FFB86C; --light: #282A36; --border: #44475A; --sidebar-bg: #21222C; --card-bg: #282A36; --shadow: 0 4px 15px rgba(0,0,0,0.2); --text-color: #F8F8F2; --secondary-text-color: #BD93F9;
      }
      body { font-family: 'Roboto', sans-serif; margin: 0; background: var(--light); color: var(--text-color); transition: background-color var(--transition); }
      .container { display: flex; min-height: 100vh; }
      .sidebar { width: 220px; background: var(--sidebar-bg); position: fixed; top: 0; bottom: 0; border-right: 1px solid var(--border); box-shadow: 2px 0 5px rgba(0,0,0,0.05); transition: width var(--transition); display: flex; flex-direction: column; z-index: 1100; }
      .sidebar.collapsed { width: 70px; }
      .sidebar-header { padding: 15px 20px; display: flex; align-items: center; justify-content: space-between; }
      .sidebar.collapsed .logo-section { display: none; }
      .sidebar-toggle { background: transparent; border: none; color: var(--primary); font-size: 1.5em; cursor: pointer; }
      .sidebar-nav { list-style: none; padding: 0; margin: 20px 0 0; }
      .sidebar .nav-btn { display: flex; align-items: center; width: calc(100% - 30px); padding: 12px 20px; margin: 5px 15px; border: none; border-radius: 8px; cursor: pointer; font-size: 1em; text-align: left; transition: var(--transition); background: transparent; color: var(--secondary-text-color); }
      .sidebar .nav-btn i { font-size: 1.2em; margin-right: 15px; width: 20px; text-align: center; }
      .sidebar .nav-btn.active, .sidebar .nav-btn:hover { background: var(--primary); color: #fff; box-shadow: var(--shadow); }
      .sidebar.collapsed .nav-btn { width: 40px; margin: 5px auto; padding: 12px; justify-content: center; }
      .sidebar.collapsed .nav-btn i { margin: 0; }
      .sidebar.collapsed .nav-btn span { display: none; }
      .main-content-wrapper { flex-grow: 1; margin-left: 220px; display: flex; flex-direction: column; transition: margin-left var(--transition); }
      .main-content-wrapper.collapsed { margin-left: 70px; }
      header { display: flex; justify-content: space-between; align-items: center; padding: 15px 30px; background: var(--card-bg); border-bottom: 1px solid var(--border); box-shadow: var(--shadow); z-index: 1000; }
      header h1 { margin: 0; font-size: 1.5em; color: var(--primary); font-family: 'Poppins', sans-serif; }
      .theme-toggle { background: var(--card-bg); color: var(--primary); border: 1px solid var(--border); padding: 8px; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 1.2em; display: flex; align-items: center; justify-content: center; transition: var(--transition); }
      .theme-toggle:hover { background: var(--primary); color: #fff; }
      .main-content { flex-grow: 1; padding: 30px 40px; }
      .summary-info { display: flex; flex-wrap: wrap; gap: 20px 40px; padding: 20px; background: var(--card-bg); border-radius: 10px; box-shadow: var(--shadow); margin-bottom: 30px; }
      .summary-info p { margin: 0; display: flex; align-items: center; font-size: 0.9em; }
      .summary-info strong { margin: 0 5px; }
      .summary-info i { color: var(--primary); margin-right: 8px; }
      .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .card { background: var(--card-bg); padding: 20px; border-radius: 10px; text-align: center; box-shadow: var(--shadow); transition: var(--transition); border-top: 4px solid; }
      .card.filter-card { cursor: pointer; }
      .card:hover { transform: translateY(-5px); box-shadow: 0 8px 20px rgba(0,0,0,0.1); }
      .card.total { border-color: var(--primary); } .card.passed { border-color: var(--success); } .card.failed { border-color: var(--danger); } .card.skipped { border-color: var(--skipped); } .card.flaky { border-color: var(--flaky); }
      .card h3 { margin: 0 0 8px; font-size: 0.9em; text-transform: uppercase; }
      .card p { margin: 0; font-size: 2em; font-weight: 700; }
      .chart-section { display: flex; flex-wrap: wrap; gap: 30px; padding: 30px; background: var(--card-bg); border-radius: 10px; box-shadow: var(--shadow); align-items: center; justify-content: center; }
      .donut-chart-container { position: relative; width: 100%; max-width: 280px; height: 280px; }
      #chart-center-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; font-family: 'Poppins', sans-serif; font-size: 1.2em; color: var(--secondary-text-color); font-weight: 600; }
      .chart-legend { flex: 1; min-width: 250px; }
      .chart-legend ul { list-style: none; padding: 0; }
      .chart-legend li { display: flex; align-items: center; margin-bottom: 10px; }
      .color-box { width: 20px; height: 20px; margin-right: 10px; border-radius: 4px; }
      .color-box.passed { background: var(--success); } .color-box.failed { background: var(--danger); } .color-box.skipped { background: var(--skipped); } .color-box.flaky { background: var(--flaky); }
      .stat-rates { margin-top: 15px; }
      .stat-rates p { margin: 8px 0; padding: 10px 15px; border-radius: 8px; font-size: 0.95em; display: flex; justify-content: space-between; color: #fff; }
      .stat-rates p.pass-rate { background: var(--success); } .stat-rates p.fail-rate { background: var(--danger); }
      .test-group { background: var(--card-bg); border-radius: 10px; margin-bottom: 20px; box-shadow: var(--shadow); border: 1px solid var(--border); overflow: hidden; }
      .test-group-header { display: flex; align-items: center; padding: 15px 20px; cursor: pointer; background-color: rgba(0,0,0,0.02); }
      .dark-theme .test-group-header { background-color: rgba(255,255,255,0.05); }
      .test-group-header h3 { margin: 0; font-size: 1.1em; flex-grow: 1; font-family: 'Poppins', sans-serif; }
      .test-group-content { padding: 10px 20px 20px 40px; display: none; }
      .test-case { border-radius: 10px; margin-bottom: 15px; border-left: 6px solid; background: var(--light); box-shadow: none; }
      .dark-theme .test-case { background: var(--sidebar-bg); }
      .test-case.passed { border-left-color: var(--success); } .test-case.failed { border-left-color: var(--danger); } .test-case.timedOut { border-left-color: var(--danger); } .test-case.skipped { border-left-color: var(--skipped); }
      .test-case-header { display: flex; align-items: center; padding: 15px; cursor: pointer; }
      .test-case-header h3 { margin: 0; font-size: 1em; flex-grow: 1; }
      .status-badge { padding: 5px 12px; border-radius: 15px; font-size: 0.8em; font-weight: 700; color: #fff; margin-left: 15px; text-transform: uppercase; }
      .status-badge.passed { background: var(--success); } .status-badge.failed { background: var(--danger); } .status-badge.skipped { background: var(--skipped); } .status-badge.flaky { background: var(--flaky); }
      .toggle-icon { margin-left: 15px; transition: transform 0.3s; }
      .test-case-header[aria-expanded="true"] .toggle-icon, .test-group-header[aria-expanded="true"] .toggle-icon { transform: rotate(90deg); }
      .test-case-details { padding: 0 15px 15px; display: none; }
      .test-detail-section { margin-top: 15px; border-top: 1px dashed var(--border); padding-top: 15px; }
      .test-detail-section h4 { margin: 0 0 10px; font-size: 1em; }
      .step-list { list-style: none; padding-left: 0; }
      .step-item { border-radius: 8px; margin-bottom: 8px; background: var(--light); border-left: 4px solid; padding: 10px 15px; }
      .step-item.passed { border-left-color: var(--success); } .step-item.failed { border-left-color: var(--danger); }
      .step-item-header { display: flex; align-items: center; cursor: pointer; }
      .step-title { flex-grow: 1; }
      .step-duration { margin-left: 15px; color: var(--secondary-text-color); font-size: 0.9em; }
      .step-status-icon { margin-left: 15px; font-size: 1.2em; }
      .step-status-icon.passed { color: var(--success); } .step-status-icon.failed { color: var(--danger); }
      .step-details { margin-top: 10px; padding-left: 25px; border-left: 2px dashed var(--border); }
      .error-message { background: rgba(220,53,69,0.1); color: var(--danger); padding: 15px; border-radius: 8px; white-space: pre-wrap; border: 1px solid var(--danger); font-family: 'Courier New', Courier, monospace; }
      .attachments-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 15px; }
      .attachment-item { border-radius: 8px; overflow: hidden; text-align: center; background: var(--light); border: 1px solid var(--border); transition: var(--transition); }
      .attachment-item:hover { box-shadow: var(--shadow); transform: translateY(-2px); }
      .attachment-item img { max-width: 100%; height: 100px; object-fit: cover; cursor: pointer; }
      .attachment-item a { display: block; padding: 10px; font-size: 0.9em; text-decoration: none; color: var(--primary); }
      .attachment-item a i { display: block; font-size: 3em; color: var(--primary); margin-bottom: 10px; }
      footer { text-align: center; padding: 20px; background: var(--card-bg); border-top: 4px solid var(--primary); margin-top: auto; font-family: 'Poppins', sans-serif; box-shadow: 0 -2px 10px rgba(0,0,0,0.05); }
      .dark-theme footer { box-shadow: 0 -2px 10px rgba(0,0,0,0.15); }
      footer span { font-size: 1em; color: var(--secondary-text-color); }
      footer strong { font-weight: 500; color: var(--primary); }
      .search-container { position: relative; max-width: 500px; margin-bottom: 25px; }
      .search-input { width: 100%; padding: 12px 20px 12px 40px; border-radius: 25px; border: 1px solid var(--border); background-color: var(--card-bg); color: var(--text-color); font-size: 1em; box-sizing: border-box; }
      .search-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.25); outline: none; }
      .search-container i { position: absolute; left: 15px; top: 50%; transform: translateY(-50%); color: var(--secondary-text-color); }
      #imageModal { display: none; position: fixed; z-index: 2000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.85); justify-content: center; align-items: center; }
      #imageModal img { max-width: 90%; max-height: 90%; }
      #imageModal .close-modal { position: absolute; top: 20px; right: 35px; color: #f1f1f1; font-size: 40px; font-weight: bold; cursor: pointer; }
    `;
  }

  // *** createHtmlContent remains largely the same, but now it receives grouped data ***
  private createHtmlContent(
    data: ReportData,
    groupedTests: GroupedTests,
    cssContent: string
  ): string {
    const passRate = data.counts.total
      ? ((data.counts.passed / data.counts.total) * 100).toFixed(2)
      : "0.00";
    const failRate = data.counts.total
      ? ((data.counts.failed / data.counts.total) * 100).toFixed(2)
      : "0.00";

    // The logo path is now a Base64 string if assets are embedded
    const logoSrc = this.options.embedAssets
      ? this.logoDestinationPath
      : this.logoDestinationPath
      ? path.basename(this.logoDestinationPath)
      : "";

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QA Automation Report</title>
        ${
          this.options.inlineCss
            ? `<style>${cssContent}</style>`
            : '<link rel="stylesheet" href="style.css">'
        }
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" />
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      </head>
      <body>
        <div id="imageModal"><span class="close-modal">&times;</span><img id="modalImage"></div>
        <div class="container">
          <div class="sidebar" id="sidebar">
            <div class="sidebar-header">
              <div class="logo-section">
                ${
                  logoSrc
                    ? `<img src="${logoSrc}" alt="Logo" style="height: 40px;">`
                    : ""
                }
              </div>
              <button class="sidebar-toggle" id="sidebarToggle" aria-label="Toggle Sidebar"><i class="fa-solid fa-bars"></i></button>
            </div>
            <ul class="sidebar-nav">
              <li><button class="nav-btn active" data-section="summary"><i class="fas fa-chart-pie"></i><span>Summary</span></button></li>
              <li><button class="nav-btn" data-section="test-cases"><i class="fas fa-tasks"></i><span>Test Cases</span></button></li>
            </ul>
          </div>
          <div class="main-content-wrapper" id="mainContentWrapper">
            <header>
              <h1>${this.options.reportTitle}</h1>
              <button class="theme-toggle" id="themeToggle" aria-label="Toggle Theme"><i class="fas fa-moon"></i></button>
            </header>
            <main class="main-content">
               <section id="summary" class="section">
                 <div class="summary-info">
                  <p><i class="fas fa-tasks"></i>Execution:<strong>${
                    this.options.executionType
                  }</strong></p>
                  <p><i class="fas fa-user-shield"></i>QA Lead:<strong>${
                    this.options.qaLead
                  }</strong></p>
                  <p><i class="fas fa-play-circle"></i>Start Time:<strong>${
                    data.startTime
                  }</strong></p>
                  <p><i class="fas fa-stop-circle"></i>End Time:<strong>${
                    data.endTime
                  }</strong></p>
                  <p><i class="fas fa-hourglass-half"></i>Duration:<strong>${(
                    data.duration / 1000
                  ).toFixed(2)}s</strong></p>
                 </div>
                 <div class="summary-cards">
                  <div class="card total filter-card" data-status="all"><h3>Total</h3><p>${
                    data.counts.total
                  }</p></div>
                  <div class="card passed filter-card" data-status="passed"><h3>Passed</h3><p>${
                    data.counts.passed
                  }</p></div>
                  <div class="card failed filter-card" data-status="failed"><h3>Failed</h3><p>${
                    data.counts.failed
                  }</p></div>
                  <div class="card skipped filter-card" data-status="skipped"><h3>Skipped</h3><p>${
                    data.counts.skipped
                  }</p></div>
                  <div class="card flaky filter-card" data-status="flaky"><h3>Flaky</h3><p>${
                    data.counts.flaky
                  }</p></div>
                 </div>
                  <div class="chart-section">
                    <div class="donut-chart-container">
                      <canvas id="testSummaryChart"></canvas>
                      <div id="chart-center-text">Overall Status</div>
                    </div>
                    <div class="chart-legend">
                        <ul>
                            <li><span class="color-box passed"></span> Passed</li>
                            <li><span class="color-box failed"></span> Failed</li>
                            <li><span class="color-box skipped"></span> Skipped</li>
                            <li><span class="color-box flaky"></span> Flaky</li>
                        </ul>
                        <div class="stat-rates">
                            <p class="pass-rate"><strong>Pass Rate:</strong> ${passRate}%</p>
                            <p class="fail-rate"><strong>Fail Rate:</strong> ${failRate}%</p>
                        </div>
                    </div>
                 </div>
               </section>
               <section id="test-cases" class="section" style="display: none;">
                 <div class="search-container">
                    <i class="fas fa-search"></i>
                    <input type="text" id="testSearchInput" class="search-input" placeholder="Search by test name...">
                 </div>
                 <div id="testCasesList">
                    ${this.generateTestCases(groupedTests)}
                 </div>
               </section>
            </main>
            <footer><span>Generated by <strong>${
              this.options.footerText
            }</strong> on ${data.endTime.split(" at ")[0]}</span></footer>
          </div>
        </div>
        <script>
            // Embedding report data directly if in single-file mode
            const reportData = ${
              this.options.embedAssets ? JSON.stringify(data) : "null"
            };

            let testSummaryChart;
            
            function getThemeColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
        
            function createChart() {
                const chartEl = document.getElementById('testSummaryChart');
                if (!chartEl) return;
                const counts = reportData.counts;
                const ctx = chartEl.getContext('2d');
                if (testSummaryChart) testSummaryChart.destroy();
                testSummaryChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Passed', 'Failed', 'Skipped', 'Flaky'],
                        datasets: [{
                            data: [counts.passed, counts.failed, counts.skipped, counts.flaky],
                            backgroundColor: [getThemeColor('--success'), getThemeColor('--danger'), getThemeColor('--skipped'), getThemeColor('--flaky')],
                            borderColor: getThemeColor('--card-bg'),
                            borderWidth: 4, hoverOffset: 8
                        }]
                    },
                    options: { 
                        responsive: true, maintainAspectRatio: false, cutout: '70%', 
                        plugins: { legend: { display: false } }
                    }
                });
            }

            document.addEventListener('DOMContentLoaded', () => {
                if(!reportData) { // Fallback if data is not embedded
                    console.error("Report data not found. Please ensure custom-report-data.json is available or assets are embedded.");
                    return;
                }
                
                createChart();
                const themeToggle = document.getElementById('themeToggle');
                const sidebar = document.getElementById('sidebar');
                const mainContentWrapper = document.getElementById('mainContentWrapper');
                const sidebarToggle = document.getElementById('sidebarToggle');
                const navButtons = document.querySelectorAll('.nav-btn');
                const sections = document.querySelectorAll('.section');
                const testSearchInput = document.getElementById('testSearchInput');
                const testCasesList = document.getElementById('testCasesList');
                const imageModal = document.getElementById('imageModal');
                const modalImage = document.getElementById('modalImage');
                const allNavButtons = document.querySelectorAll('.nav-btn');

                const applyTheme = (theme) => {
                    document.body.classList.toggle('dark-theme', theme === 'dark');
                    themeToggle.querySelector('i').className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
                    if (document.getElementById('testSummaryChart')) createChart();
                };

                const setSidebarState = (collapsed) => {
                    sidebar.classList.toggle('collapsed', collapsed);
                    mainContentWrapper.classList.toggle('collapsed', collapsed);
                    sidebarToggle.querySelector('i').className = collapsed ? 'fa-solid fa-bars' : 'fa-solid fa-xmark';
                };

                const navigateToTab = (sectionId) => {
                    allNavButtons.forEach(btn => btn.classList.remove('active'));
                    const targetBtn = document.querySelector(\`.nav-btn[data-section="\${sectionId}"]\`);
                    if (targetBtn) targetBtn.classList.add('active');
                    
                    sections.forEach(section => section.style.display = 'none');
                    document.getElementById(sectionId).style.display = 'block';
                };

                const filterTests = (status) => {
                    testSearchInput.value = '';
                    document.querySelectorAll('.test-group').forEach(group => {
                        let visibleTestsInGroup = 0;
                        group.querySelectorAll('.test-case').forEach(testCase => {
                            let show = false;
                            const testStatus = testCase.dataset.status;
                            const isFlaky = testCase.dataset.isFlaky === 'true';

                            if (status === 'all') show = true;
                            else if (status === 'flaky') show = isFlaky;
                            else if (status === 'failed') show = testStatus === 'failed' || testStatus === 'timedOut';
                            else show = testStatus === status;
                            
                            testCase.style.display = show ? '' : 'none';
                            if (show) visibleTestsInGroup++;
                        });

                        group.style.display = visibleTestsInGroup > 0 ? '' : 'none';
                        const groupHeader = group.querySelector('.test-group-header');
                        const groupContent = group.querySelector('.test-group-content');
                        if (groupHeader && groupContent) {
                            const isExpanded = visibleTestsInGroup > 0;
                            groupHeader.setAttribute('aria-expanded', isExpanded.toString());
                            groupContent.style.display = isExpanded ? 'block' : 'none';
                        }
                    });
                };

                themeToggle.addEventListener('click', () => {
                    const newTheme = document.body.classList.contains('dark-theme') ? 'light' : 'dark';
                    localStorage.setItem('theme', newTheme);
                    applyTheme(newTheme);
                });

                sidebarToggle.addEventListener('click', () => {
                    const isCollapsed = !sidebar.classList.contains('collapsed');
                    localStorage.setItem('sidebarCollapsed', isCollapsed);
                    setSidebarState(isCollapsed);
                });
                
                navButtons.forEach(button => {
                    button.addEventListener('click', () => {
                        navigateToTab(button.dataset.section);
                        if (button.dataset.section === 'test-cases') filterTests('all');
                    });
                });
                
                document.querySelectorAll('.filter-card').forEach(card => {
                    card.addEventListener('click', () => {
                        const statusToFilter = card.dataset.status;
                        navigateToTab('test-cases');
                        filterTests(statusToFilter);
                    });
                });

                testSearchInput.addEventListener('input', (e) => {
                    const searchTerm = e.target.value.toLowerCase();
                    document.querySelectorAll('.test-group').forEach(group => {
                       let groupHasVisibleMatch = false;
                       group.querySelectorAll('.test-case').forEach(testCase => {
                           const title = testCase.dataset.title.toLowerCase();
                           const isMatch = title.includes(searchTerm);
                           testCase.style.display = isMatch ? '' : 'none';
                           if(isMatch) groupHasVisibleMatch = true;
                       });
                       group.style.display = groupHasVisibleMatch ? '' : 'none';
                       const groupHeader = group.querySelector('.test-group-header');
                        if (groupHeader && groupHasVisibleMatch) {
                            groupHeader.setAttribute('aria-expanded', 'true');
                            groupHeader.nextElementSibling.style.display = 'block';
                        }
                    });
                });
                
                document.body.addEventListener('click', e => {
                    const testCaseHeader = e.target.closest('.test-case-header');
                    if (testCaseHeader) {
                        const details = testCaseHeader.nextElementSibling;
                        const isExpanded = testCaseHeader.getAttribute('aria-expanded') === 'true';
                        testCaseHeader.setAttribute('aria-expanded', !isExpanded);
                        details.style.display = isExpanded ? 'none' : 'block';
                    }
                    
                    const testGroupHeader = e.target.closest('.test-group-header');
                    if(testGroupHeader) {
                        const details = testGroupHeader.nextElementSibling;
                        const isExpanded = testGroupHeader.getAttribute('aria-expanded') === 'true';
                        testGroupHeader.setAttribute('aria-expanded', !isExpanded);
                        details.style.display = isExpanded ? 'none' : 'block';
                    }

                    const imageThumb = e.target.closest('.attachment-item img');
                    if(imageThumb) {
                        modalImage.src = imageThumb.src;
                        imageModal.style.display = 'flex';
                    }

                    if(e.target.matches('.close-modal') || e.target.id === 'imageModal') {
                        imageModal.style.display = 'none';
                    }
                });

                applyTheme(localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
                if (localStorage.getItem('sidebarCollapsed') === 'true') setSidebarState(true);
            });
        </script>
      </body>
      </html>
    `;
  }

  private generateTestCases(groupedTests: GroupedTests): string {
    let html = "";
    groupedTests.forEach((tests, groupTitle) => {
      html += `
            <div class="test-group">
                <div class="test-group-header" aria-expanded="false">
                    <h3>${this.escapeHtml(groupTitle)}</h3>
                    <i class="fas fa-chevron-right toggle-icon"></i>
                </div>
                <div class="test-group-content">
                    ${tests
                      .map((test) => this.generateSingleTestCase(test))
                      .join("")}
                </div>
            </div>
        `;
    });
    return html;
  }

  private generateSingleTestCase(test: ReportData["tests"][0]): string {
    const fullTitlePath = test.fullTitle.split(" > ");
    const testTitle = fullTitlePath.slice(1).join(" > ");

    let badgeClass: string = test.status;
    let badgeText: string = test.status;

    if (badgeText === "timedOut" || badgeText === "interrupted") {
      badgeClass = "failed";
      badgeText = "failed";
    }

    if (test.retries > 0) {
      badgeText = "Flaky";
      badgeClass = "flaky";
    }

    return `
        <div class="test-case ${test.status}" data-title="${
      test.fullTitle
    }" data-status="${test.status}" data-is-flaky="${test.retries > 0}">
          <div class="test-case-header" aria-expanded="false">
            <h3>${this.escapeHtml(testTitle)}</h3>
            <span class="status-badge ${badgeClass}">${badgeText}</span>
            <i class="fas fa-chevron-right toggle-icon"></i>
          </div>
          <div class="test-case-details">
             <div class="summary-info" style="gap: 20px;">
                <p><i class="fas fa-laptop-code"></i>Project:<strong>${
                  test.projectName
                }</strong></p>
                <p><i class="fas fa-hourglass-half"></i>Duration:<strong>${(
                  test.duration / 1000
                ).toFixed(2)}s</strong></p>
                <p><i class="fas fa-redo"></i>Retries:<strong>${
                  test.retries
                }</strong></p>
             </div>
             ${
               test.errors.length > 0
                 ? `<div class="test-detail-section"><h4>Errors</h4>${test.errors
                     .map(
                       (error) =>
                         `<pre class="error-message">${this.escapeHtml(
                           error
                         )}</pre>`
                     )
                     .join("")}</div>`
                 : ""
             }
             ${
               test.steps.length > 0
                 ? `<div class="test-detail-section"><h4>Steps</h4><ul class="step-list">${this.generateStepList(
                     test.steps
                   )}</ul></div>`
                 : ""
             }
             ${
               test.attachments.length > 0
                 ? `
               <div class="test-detail-section">
                 <h4>Attachments</h4>
                 <div class="attachments-grid">
                   ${test.attachments
                     .map(
                       (attachment) => `
                     <div class="attachment-item">
                       ${
                         attachment.contentType.startsWith("image/")
                           ? `<img src="${attachment.path}" alt="${attachment.name}" loading="lazy">`
                           : `<a href="${attachment.path}" target="_blank" download>
                                <i class="far fa-file-alt"></i>
                                <span>${attachment.name}</span>
                              </a>`
                       }
                     </div>`
                     )
                     .join("")}
                 </div>
               </div>`
                 : ""
             }
          </div>
        </div>`;
  }

  private generateStepList(steps: ReportData["tests"][0]["steps"]): string {
    return steps
      .map(
        (step) => `
        <li class="step-item ${step.status}">
          <div class="step-item-header">
             <span class="step-title">${this.escapeHtml(step.title)}</span>
             <span class="step-duration">${step.duration}ms</span>
             <i class="fas fa-${
               step.status === "passed" ? "check-circle" : "times-circle"
             } step-status-icon ${step.status}"></i>
          </div>
          ${
            step.error || (step.steps && step.steps.length > 0)
              ? `
            <div class="step-details" style="display:none;">
              ${
                step.error
                  ? `<div class="error-message">${this.escapeHtml(
                      step.error
                    )}</div>`
                  : ""
              }
              ${
                step.steps && step.steps.length > 0
                  ? `<ul class="step-list">${this.generateStepList(
                      step.steps
                    )}</ul>`
                  : ""
              }
            </div>`
              : ""
          }
        </li>`
      )
      .join("");
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

export default MyCustomReporter;
