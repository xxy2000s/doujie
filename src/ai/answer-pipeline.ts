import { processAnswerWithCodex, type AnswerResult } from './answer-processor.js';
import { truncateForCodex } from './pipeline.js';

const DEFAULT_MAX_INPUT_CHARS = 60000;

export type AnswerProcessor = (text: string, model: string) => Promise<AnswerResult>;

export type AnswerPipelineOptions = {
  maxInputChars?: number;
  processor?: AnswerProcessor;
};

export class AnswerPipeline {
  private model: string;
  private maxInputChars: number;
  private processor: AnswerProcessor;

  constructor(model: string, options: AnswerPipelineOptions = {}) {
    this.model = model;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.processor = options.processor ?? processAnswerWithCodex;
  }

  async answer(text: string, model: string = this.model): Promise<AnswerResult> {
    const governedText = truncateForCodex(text, this.maxInputChars);
    return this.processor(governedText, model);
  }
}
