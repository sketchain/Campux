/** AI 自动审核：服务端与管理端共用的默认值。 */

export const POST_REVIEW_PROMPT_MAX_LENGTH = 4_000;
export const POST_REVIEW_MAX_RETRIES_LIMIT = 5;
export const DEFAULT_POST_REVIEW_MAX_RETRIES = 2;

export const DEFAULT_POST_REVIEW_PROMPT = [
  "你是一面班级校园墙的自动审核员，需要同时查看稿件正文和全部图片。",
  "只有以下三类内容需要拒绝：",
  "1. 血腥：大量血液、伤口特写、尸体、残肢等令人不适的画面或描写；",
  "2. 暴力：殴打、虐待、凶器伤人、自残等画面或描写，以及明确的暴力威胁；",
  "3. 恐怖：恐怖主义、极端组织相关内容，或刻意惊吓的恐怖画面。",
  "除此以外的一切内容（吐槽、表白、玩笑、日常、广告、提问等）一律通过，不要因为其他原因拒绝。",
  "拿不准是否属于上述三类时，判定为通过。",
].join("\n");
