const MAX_RAW_CONTENT_LENGTH = 64 * 1024;
const MAX_QUESTION_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 256;
const MAX_QUESTION_LENGTH = 8 * 1024;
const MAX_OPTION_COUNT = 20;
const MAX_OPTION_TEXT_LENGTH = 512;
const QUESTION_ID = /^[A-Za-z0-9._:-]+$/;

interface ParsedAskQuestionOption {
  label: string;
  selectedLabel: string;
  value: string;
}

export interface ParsedAskQuestion {
  questionId: string;
  title: string;
  question: string;
  options: ParsedAskQuestionOption[];
}

export interface TrustedQuestionResponse {
  questionId: string;
  selectedOption: string;
  cancelled: boolean;
  responseChannel: string | null;
}

export interface WebAskQuestionPresentation {
  type: 'ask-question';
  mode: 'read-only';
  title: string;
  question: string;
  options: Array<{
    label: string;
    selected: boolean;
  }>;
  state: 'awaiting-external-response' | 'answered' | 'cancelled' | 'closed';
  selectedLabel: string | null;
  responseChannel: string | null;
}

function boundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) return null;
  return normalized;
}

function parseOption(raw: unknown): ParsedAskQuestionOption | null {
  if (typeof raw === 'string') {
    const text = boundedText(raw, MAX_OPTION_TEXT_LENGTH);
    return text ? { label: text, selectedLabel: text, value: text } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const label = boundedText(candidate.label, MAX_OPTION_TEXT_LENGTH);
  if (!label) return null;
  const selectedLabel =
    candidate.selectedLabel === undefined ? label : boundedText(candidate.selectedLabel, MAX_OPTION_TEXT_LENGTH);
  const value = candidate.value === undefined ? label : boundedText(candidate.value, MAX_OPTION_TEXT_LENGTH);
  if (!selectedLabel || !value) return null;
  return { label, selectedLabel, value };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw || raw.length > MAX_RAW_CONTENT_LENGTH) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseAskQuestion(raw: string): ParsedAskQuestion | null {
  const candidate = parseJsonObject(raw);
  if (!candidate || candidate.type !== 'ask_question') return null;
  const questionId = boundedText(candidate.questionId, MAX_QUESTION_ID_LENGTH);
  const title = boundedText(candidate.title, MAX_TITLE_LENGTH);
  const question = boundedText(candidate.question, MAX_QUESTION_LENGTH);
  if (!questionId || !QUESTION_ID.test(questionId) || !title || !question) return null;
  if (
    !Array.isArray(candidate.options) ||
    candidate.options.length < 1 ||
    candidate.options.length > MAX_OPTION_COUNT
  ) {
    return null;
  }
  const options = candidate.options.map(parseOption);
  if (options.some((option) => option === null)) return null;
  return { questionId, title, question, options: options as ParsedAskQuestionOption[] };
}

export function parseTrustedQuestionResponse(
  raw: string,
  responseChannel: string | null,
): TrustedQuestionResponse | null {
  const candidate = parseJsonObject(raw);
  if (!candidate || candidate.type !== 'question_response') return null;
  const questionId = boundedText(candidate.questionId, MAX_QUESTION_ID_LENGTH);
  const selectedOption = boundedText(candidate.selectedOption, MAX_OPTION_TEXT_LENGTH);
  if (!questionId || !QUESTION_ID.test(questionId) || !selectedOption) return null;
  return {
    questionId,
    selectedOption,
    cancelled: candidate.cancelled === true || selectedOption === '__cancelled__',
    responseChannel,
  };
}

export function malformedAskQuestionFallback(raw: string): string | null {
  const candidate = parseJsonObject(raw);
  if (!candidate || candidate.type !== 'ask_question') return null;
  return (
    boundedText(candidate.question, MAX_QUESTION_LENGTH) ??
    boundedText(candidate.title, MAX_TITLE_LENGTH) ??
    '问题卡片无法显示'
  );
}

export function buildAskQuestionPresentation(args: {
  question: ParsedAskQuestion;
  response?: TrustedQuestionResponse;
  pending: boolean;
}): WebAskQuestionPresentation {
  const response = args.response;
  const selected = response
    ? args.question.options.find((option) => option.value === response.selectedOption)
    : undefined;
  const state: WebAskQuestionPresentation['state'] = response?.cancelled
    ? 'cancelled'
    : selected
      ? 'answered'
      : response
        ? 'closed'
        : args.pending
          ? 'awaiting-external-response'
          : 'closed';
  return {
    type: 'ask-question',
    mode: 'read-only',
    title: args.question.title,
    question: args.question.question,
    options: args.question.options.map((option) => ({
      label: option.label,
      selected: state === 'answered' && option === selected,
    })),
    state,
    selectedLabel: state === 'answered' && selected ? selected.selectedLabel : null,
    responseChannel: response?.responseChannel ?? null,
  };
}
