export class TurnCancelledError extends Error {
  constructor(message = '当前轮次已取消') {
    super(message);
    this.name = 'TurnCancelledError';
  }
}
