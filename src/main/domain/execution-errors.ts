export class PreSubmitBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreSubmitBlockedError'
  }
}
