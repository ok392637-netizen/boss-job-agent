export const URLS = Object.freeze({
  home: "https://www.zhipin.com/",
  cityHome: (city) => `https://www.zhipin.com/${city === "101280100" ? "guangzhou" : ""}/`,
  login: "https://www.zhipin.com/web/user/",
  search: ({ city, query }) => {
    const parameters = new URLSearchParams({ city, query });
    return `https://www.zhipin.com/web/geek/job?${parameters}`;
  },
  messages: "https://www.zhipin.com/web/geek/chat",
});

export const SELECTORS = Object.freeze({
  // Verified 2026-06-13 on the logged-out Guangzhou landing page.
  loggedOutHeader: "a.header-login-btn[href*='/web/user/']",
  loggedInHeader:
    ".nav-figure, .user-nav, .nav-user, a[href*='/web/geek/recommend']",

  // Verified 2026-06-13 logged-in.
  jobCard: "li.job-card-box",
  // Verified 2026-06-13 logged-in.
  jobCardLink: "a.job-name[href*='/job_detail/']",
  // Verified 2026-06-13 logged-in.
  jobTitle: ".job-name",
  // Verified 2026-06-13 logged-in.
  companyName: ".job-card-footer .boss-name",
  // Verified 2026-06-13 logged-in.
  salary: ".job-salary",
  // Verified 2026-06-13 logged-in.
  jobArea: ".job-card-footer .company-location",
  // Verified 2026-06-13 logged-in: current cards do not expose recruiter names.
  hrName: ".info-public .name",

  // Verified fallback on the public Guangzhou landing page.
  publicJobLink: ".sub-li > a.job-info[href*='/job_detail/']",

  // Verified 2026-06-13 patchright logged-in.
  detailTitle: ".job-banner .name h1, .job-detail-box .job-name",
  // Verified 2026-06-13 patchright logged-in: the first .company-info is the
  // title/salary block and the second is the company name.
  detailCompany: ":nth-match(.company-info, 2)",
  // Verified 2026-06-13 patchright logged-in.
  detailSalary: ".job-banner .salary, .job-detail-box .salary",
  // Verified 2026-06-13 patchright logged-in.
  detailDescription:
    ".job-detail > .job-detail-section:first-child .job-sec-text",
  // Verified 2026-06-13 patchright logged-in.
  detailHrName: ".job-boss-info h2.name",
  // Verified 2026-06-13 on a logged-out public job detail page.
  startChatButton: ".btn-startchat",

  // Verified 2026-06-13 patchright logged-in: 聊天输入框是 contenteditable 的 div.chat-input。
  chatEditor:
    "div.chat-input, .chat-input[contenteditable], .chat-input textarea, [contenteditable='true'][role='textbox']",
  // Verified 2026-06-13: 发送按钮 button.btn-send, 未输入文本时带 disabled, 仅匹配已激活的。
  sendMessageButton: "button.btn-send:not(.disabled)",

  // Login UI selectors are intentionally broad because the live logged-out
  // page was blanked by the same security chain before the QR UI rendered.
  loginContainer: ".login-wrap, .login-box, .login-container",
  qrCode: ".scan-login img, .login-scan img, .qr-code img, .qrcode-box img",

  securityIframe:
    "iframe[src*='captcha'], iframe[src*='verify'], iframe[src*='geetest'], iframe[title*='验证'], iframe[title*='滑块']",

  // Verified 2026-06-13 patchright logged-in.
  inboxConversation:
    ".user-list-content > ul[role='group'] > li[role='listitem']",
  // TODO: verified 2026-06-13 patchright logged-in with no unread
  // conversations present. These are the best-known unread marker forms.
  inboxUnread: ".unread-count, [class*='unread']",
  // Verified 2026-06-13 patchright logged-in.
  inboxHrName: ".title-box .name-box .name-text",
  // Verified 2026-06-13 patchright logged-in.
  inboxLastMessage: ".last-msg .last-msg-text",
  // TODO: verified 2026-06-13 patchright logged-in: the conversation list
  // did not expose a job title. Keep the known detail-panel forms.
  inboxJobTitle: ".source-job, .position-name, .job-name",
  // TODO: verified 2026-06-13 patchright logged-in: list items were Vue
  // controls without anchors. Keep the route form for accounts that render it.
  inboxConversationLink: "a[href*='/web/geek/chat?id=']",
});
