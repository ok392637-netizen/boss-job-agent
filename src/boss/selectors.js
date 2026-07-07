export const URLS = Object.freeze({
  home: "https://www.zhipin.com/",
  cityHome: (city) => `https://www.zhipin.com/${city === "101280100" ? "guangzhou" : ""}/`,
  login: "https://www.zhipin.com/web/user/",
  recommend: "https://www.zhipin.com/web/geek/recommend",
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

  // Verified 2026-07-04 by scripts/verify-company-dom.mjs:
  // data/logs/verify-company-dom-2026-07-04T10-27-52-091Z.log.
  detailCompanyLink:
    ".company-info a[href*='/gongsi/'], a[ka^='job-detail-company'][href*='/gongsi/']",
  companyBanner: ".company-banner",
  companyPageName: ".company-banner .info-primary .info .name, .company-banner h1.name",
  companyBannerMeta: ".company-banner .info-primary .info p",
  companyIndustry: ".company-banner .industry-link",
  companyBusinessDetail: ".business-detail",
  companyStat: ".company-stat",
  companyJobsLink:
    ".company-tab a[href*='/gongsi/job/'], .company-stat a[href*='/gongsi/job/']",
  companyJobCount: ".company-stat a[href*='/gongsi/job/'] b",
  companyJobCard: "li.job-card-box, .job-list li",
  companyJobTitle: ".job-name",
  companyJobSalary: ".job-salary",
  companyNextPage: ".options-pages a.next:not(.disabled), a.next:not(.disabled)",

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

  // Verified 2026-07-04 by scripts/verify-chat-dom.mjs:
  // data/logs/verify-chat-dom-2026-07-04T03-49-25-920Z.log.
  chatConversationItem:
    ".user-list-content > ul[role='group'] > li[role='listitem']",
  chatConversationSearchInput:
    "input[placeholder*='搜索'], .search-input input, [class*='search'] input",
  chatSearchResultItem: "li.search-list",
  chatSearchResultName: ".boss-name, .first-line .boss-name",
  chatConvHrName: ".title-box .name-box .name-text",
  chatConvCompany: ".title-box .name-box span:not(.name-text)",
  chatConvJobTitle: ".source-job, .position-name, .job-name",
  chatConvLastMsg: ".last-msg .last-msg-text",
  chatConvLastMsgTime: ".time",
  chatConvUnread: ".unread-count, [class*='unread']",
  // Verified 2026-07-04 by scripts/verify-chat-dom.mjs:
  // data/logs/verify-chat-dom-2026-07-04T08-32-30-888Z.log.
  chatSelectedConversationItem:
    ".user-list-content > ul[role='group'] > li[role='listitem']:has(.friend-content.selected), .user-list-content > ul[role='group'] > li[role='listitem']:has(.friend-content-warp.selected)",
  chatOpenJobTitle:
    ".chat-container .chat-position-content .position-name, .chat-container .position-name, .position-content .position-name",
  chatMsgItem: "li.message-item",
  chatMsgMine: "li.message-item.item-myself",
  chatMsgSystem:
    "li.message-item.item-system, li.message-item:has(.message-card-wrap), li.message-item:has(.articles-center)",
  chatMsgText:
    ".text-content, .hyper-link, .message-card-top-title, .message-card-top-text, .text, .message-content",
  chatMsgTimeLabel: ".message-time, .time, .message-status",

  // Verified 2026-07-04 by scripts/verify-chat-resume-dom.mjs:
  // data/logs/verify-chat-resume-dom-2026-07-04T17-13-27-629Z.log and
  // data/logs/verify-chat-resume-dom-2026-07-04T17-16-43-216Z.log.
  // Boss chat does not expose a per-file attachment-library picker in the
  // observed flow. "发简历" sends an attachment-resume request; Boss later
  // auto-sends the stored attachment resume after the other side agrees.
  chatResumeToolbarButton:
    ".chat-editor [d-c='62009'].toolbar-btn:not(.unable), .chat-editor .toolbar-btn:has-text('发简历'):not(.unable)",
  chatResumeToolbarButtonAny:
    ".chat-editor [d-c='62009'].toolbar-btn, .chat-editor .toolbar-btn:has-text('发简历')",
  chatResumeRequestCard:
    "li.message-item:has-text('对方请你发送附件简历'), li.message-item:has-text('我想要一份您的附件简历'), li.message-item:has(.message-card-top-title:has-text('附件简历'))",
  chatResumeRequestAgreeButton:
    "a.link-agree:has-text('附件简历'), .card-btn:has-text('同意'), button:has-text('同意')",
  chatResumeSentReceipt:
    "li.message-item:has-text('您的附件简历已发送给对方'), li.message-item:has-text('已发送给Boss'), li.message-item:has(.message-card-wrap.boss-green):has-text('附件简历')",
  chatResumeRequestSentReceipt:
    "li.message-item.item-system:has-text('附件简历请求已发送'), li.message-item:has-text('附件简历请求已发送')",
  chatResumeUploadSelectDialog:
    ".upload-select-dialog.dialog-wrap, .upload-select-dialog .dialog-container",
  chatResumeUploadResumeOption:
    ".upload-select-dialog .select-one:has-text('上传简历')",
  chatResumeSendOnlineOption:
    ".upload-select-dialog .select-one:has-text('发送在线简历')",
  chatResumeDialogCloseButton:
    ".upload-select-dialog [ka='dialog_close'], .upload-resume-dialog [ka='dialog_close'], [ka='dialog_close'], .dialog-header .close",
  chatResumePanelItem: ".list-item",
  chatResumePanelItemName: ".resume-name",
  chatResumeConfirmSendButton:
    "button.btn-confirm:not(.disabled), button.btn-sure-v2:not(.disabled)",

  // Attachment library selectors are text/CSS hybrid candidates. Verified
  // selectors are recorded by scripts/verify-attachment-dom.mjs logs.
  attachmentPanel:
    ".attachment-manage, .resume-attachment, [class*='attachment'][class*='manage'], [class*='resume'][class*='manage'], [class*='file'][class*='manage']",
  attachmentTitle: "text=附件管理",
  attachmentCount:
    ".resume-attachment .resume-type-title, .file-count, .attachment-count, [class*='file'][class*='count'], [class*='attachment'][class*='count'], [class*='count']",
  attachmentItem:
    ".resume-attachment .annex-list > li, .resume-attachment .annex-item, .attachment-item, .resume-item, .file-item, li:has(button[aria-label='更多']), li:has(.more-menu), [class*='attachment'][class*='item'], [class*='file'][class*='item']",
  attachmentName:
    ".annex-content .basis a[title], .basis a[title], .attachment-name, .resume-name, .file-name, [class*='attachment'][class*='name'], [class*='resume'][class*='name'], [class*='file'][class*='name']",
  attachmentUpdatedAt:
    ".annex-content .desc, .attachment-time, .resume-time, .file-time, [class*='time'], [class*='date'], [class*='update']",
  attachmentMoreButton:
    ".annex-item-operate, button[aria-label='更多'], button[aria-label='more'], .more-menu, [class*='more'], [class*='operate'], [class*='menu']",
  attachmentAddButton:
    ".resume-attachment .sider-title-operate, .upload-add, button[aria-label='新增附件'], button:has-text('+'), [class*='upload'][class*='add'], [class*='plus']",
  attachmentUploadMenu:
    ".resume-attachment .operate-list, .upload-menu, [class*='upload'][class*='menu'], [class*='dropdown'], [role='menu']",
  attachmentUploadResumeMenuItem:
    ".resume-attachment .operate-list .operate-list-item:has(.operate-item-resume), button:has-text('上传简历'), li.operate-list-item:has-text('上传简历'), [role='menuitem']:has-text('上传简历')",
  attachmentUploadModal:
    ".upload-resume-dialog, .upload-select-dialog, .upload-modal, [role='dialog']:has-text('上传附件简历'), [class*='upload'][class*='dialog'], [class*='upload'][class*='modal']",
  attachmentUploadFileInput: "input[type='file']",
  attachmentUploadConfirmButton:
    "a.btn-file:has-text('上传附件简历'), button:has-text('上传附件简历'), button:has-text('上传'), .upload-confirm",
  attachmentUploadCommitButton:
    "button:has-text('确定添加'), a:has-text('确定添加'), .btn-primary:has-text('确定添加'), [class*='confirm']:has-text('确定添加')",
  attachmentModalCloseButton:
    "[ka='dialog_close'], .dialog-header .close, button:has-text('关闭'), button:has-text('取消'), .modal-close, [aria-label='关闭']",
  attachmentRowMenu:
    ".resume-attachment .annex-operate-list, .row-menu, [class*='dropdown'], [role='menu'], [class*='menu']",
  attachmentDeleteMenuItem:
    ".annex-operate-delete, .delete-entry, button:has-text('删除'), li.annex-operate-delete:has-text('删除'), [role='menuitem']:has-text('删除')",
  attachmentDeleteDialog:
    ".delete-dialog, [role='dialog']:has-text('确认删除'), [role='dialog']:has-text('温馨提示'), [class*='dialog'], [class*='modal']",
  attachmentDeleteCancelButton:
    "button:has-text('取消'), a:has-text('取消'), .btn:has-text('取消'), .cancel-delete",
  attachmentDeleteConfirmButton:
    "button:has-text('确定'), button:has-text('确认'), a:has-text('确定'), a:has-text('确认'), .btn-primary:has-text('确定'), .confirm-delete",
  attachmentToast:
    ".toast, .message, [class*='toast'], [class*='message']:has-text('删除成功'), [class*='message']:has-text('上传成功')",
});
