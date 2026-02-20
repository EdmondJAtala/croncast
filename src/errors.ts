export class CroncastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CroncastError';
  }
}

export class ConfigError extends CroncastError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class BrowserConnectionError extends CroncastError {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserConnectionError';
  }
}

export class RecordingError extends CroncastError {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingError';
  }
}

export class PageNotFoundError extends CroncastError {
  constructor(message: string) {
    super(message);
    this.name = 'PageNotFoundError';
  }
}
