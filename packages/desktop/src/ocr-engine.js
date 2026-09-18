const Tesseract = require('tesseract.js');

class OCREngine {
  constructor(language = 'eng') {
    this.worker = null;
    this.language = language;
    this.isProcessing = false;
    this.ready = false;
  }

  async init() {
    if (this.worker && this.ready) return this;
    try {
      this.worker = await Tesseract.createWorker(this.language, 1, {
        logger: () => {} // Suppress Tesseract logs
      });
      this.ready = true;
      console.log('OCR engine initialized with language:', this.language);
    } catch (e) {
      console.error('OCR init failed:', e.message);
      this.ready = false;
    }
    return this;
  }

  async extractText(imagePath) {
    if (this.isProcessing || !this.worker) return null;
    this.isProcessing = true;

    try {
      const result = await this.worker.recognize(imagePath);
      const text = result.data.text;
      const confidence = result.data.confidence;
      this.isProcessing = false;
      return { text, confidence };
    } catch (e) {
      console.error('OCR Error:', e.message);
      this.isProcessing = false;
      return null;
    }
  }

  detectQuestion(text) {
    if (!text) return null;

    const cleaned = text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const patterns = [
      /(?:Q[\.\:]\s*|Question[\.\:]\s*|Q\d+[\.\:]\s*)([\s\S]*?)(?=\n\n|\n(?:A|Ans|Answer|Option)|$)/gi,
      /([^\n]+\?)/g,
      /(?:Which|What|How|Why|When|Where|Who|Select|Choose|Identify|Describe|Explain|Calculate)[\s\S]*?(?=\n\n|$)/gi
    ];

    const questions = [];
    for (const pattern of patterns) {
      try {
        const matches = cleaned.matchAll(pattern);
        for (const match of matches) {
          const q = (match[1] || match[0]).trim();
          if (q.length > 10 && q.length < 1000) {
            questions.push(q);
          }
        }
      } catch (e) {
        // Skip broken pattern
      }
    }

    // Detect A/B/C/D options
    const optionPattern = /(?:^|\n)\s*([A-D])[\.\)]\s*(.+)/g;
    const options = [];
    let optMatch;
    while ((optMatch = optionPattern.exec(cleaned)) !== null) {
      options.push({ letter: optMatch[1], text: optMatch[2].trim() });
    }

    // Detect numbered options
    const numberedPattern = /(?:^|\n)\s*\d+[\.\)]\s*(.+)/g;
    const numberedOptions = [];
    let numMatch;
    while ((numMatch = numberedPattern.exec(cleaned)) !== null) {
      numberedOptions.push(numMatch[1].trim());
    }

    // OCR often produces the same question through multiple patterns. Preserve
    // all useful candidates but avoid sending duplicates downstream.
    const uniqueQuestions = [...new Map(questions.map((q) => [q.toLowerCase(), q])).values()];
    if (uniqueQuestions.length > 0) {
      return {
        question: uniqueQuestions[0],
        options: options.length > 0 ? options : null,
        numberedOptions: numberedOptions.length > 0 ? numberedOptions : null,
        fullText: cleaned
      };
    }

    // Fallback: use any substantial text
    if (cleaned.length > 20 && cleaned.length < 2000) {
      return {
        question: cleaned,
        options: options.length > 0 ? options : null,
        numberedOptions: numberedOptions.length > 0 ? numberedOptions : null,
        fullText: cleaned,
        isContext: true
      };
    }

    return null;
  }

  formatForAI(detected) {
    if (!detected) return null;

    let prompt = `Answer this question thoroughly and in full detail:\n\n${detected.question}`;

    if (detected.options && detected.options.length > 0) {
      prompt += '\n\nOptions:';
      for (const opt of detected.options) {
        prompt += `\n${opt.letter}) ${opt.text}`;
      }
      prompt += '\n\nGive the correct option letter, explain why it is correct and why the others are wrong.';
    } else if (detected.numberedOptions && detected.numberedOptions.length > 0) {
      prompt += '\n\nOptions:';
      detected.numberedOptions.forEach((opt, i) => {
        prompt += `\n${i + 1}. ${opt}`;
      });
      prompt += '\n\nGive the correct option number, explain why it is correct and why the others are wrong.';
    }

    return prompt;
  }

  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }
}

module.exports = OCREngine;
