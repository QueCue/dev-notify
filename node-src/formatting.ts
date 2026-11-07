// 保留原有导出入口；格式化与分段算法由 notify-core 维护。
import { createFormatting } from '@quecue/notify-core';
import { t } from './i18n.js';
export type { Span, Block } from '@quecue/notify-core';
export { escapeHtml, partTitle } from '@quecue/notify-core';
export const { parseMarkdown, visibleText, telegramParts, feishuParts } = createFormatting(key => t(key));
