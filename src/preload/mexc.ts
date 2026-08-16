import { ipcRenderer } from 'electron'

interface PrepareOrderRequest {
  direction: 'UP' | 'DOWN'
  amount: string
  selectors?: {
    amountInput?: string
    upButton?: string
    downButton?: string
    submitButton?: string
  }
  allowSemanticFallback: boolean
  allowSubmit: boolean
}

function visible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  const style = window.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
}

function elementLabel(element: Element): string {
  return `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesDirection(element: Element, direction: 'UP' | 'DOWN'): boolean {
  const label = elementLabel(element)
  return direction === 'UP'
    ? /^(?:涨(?:\s|\d|$)|up(?:\s|\d|$))/i.test(label)
    : /^(?:跌(?:\s|\d|$)|down(?:\s|\d|$))/i.test(label)
}

function matchesSubmit(element: Element, direction?: 'UP' | 'DOWN'): boolean {
  const label = elementLabel(element)
  if (!direction) return /^(?:买入|buy)(?:\s|$)/i.test(label)
  return direction === 'UP'
    ? /^(?:买入|buy)\s*(?:涨|up)(?:\s|$)/i.test(label)
    : /^(?:买入|buy)\s*(?:跌|down)(?:\s|$)/i.test(label)
}

function safeQuery(selector?: string): Element | null {
  if (!selector) return null
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

function firstVisible<T extends Element>(elements: Iterable<T>, predicate?: (element: T) => boolean): T | null {
  return Array.from(elements).find((element) => visible(element) && (!predicate || predicate(element))) ?? null
}

function resolveAmountInput(selector: string | undefined, allowSemanticFallback: boolean): HTMLInputElement | null {
  const calibrated = safeQuery(selector)
  if (calibrated instanceof HTMLInputElement && visible(calibrated)) return calibrated
  if (!allowSemanticFallback) return null
  return firstVisible(document.querySelectorAll<HTMLInputElement>('input[placeholder="0"]'))
}

function resolveDirectionButton(direction: 'UP' | 'DOWN', selector: string | undefined, allowSemanticFallback: boolean): HTMLElement | null {
  const calibrated = safeQuery(selector)
  if (visible(calibrated)) return calibrated
  if (!allowSemanticFallback) return null
  return firstVisible(document.querySelectorAll<HTMLElement>('button'), (button) => matchesDirection(button, direction))
}

function resolveSubmitButton(direction: 'UP' | 'DOWN' | undefined, selector: string | undefined, allowSemanticFallback: boolean): HTMLElement | null {
  const calibrated = safeQuery(selector)
  if (visible(calibrated)) return calibrated
  if (!allowSemanticFallback) return null
  return firstVisible(document.querySelectorAll<HTMLElement>('button'), (button) => matchesSubmit(button, direction))
}

function disabled(element: HTMLElement): boolean {
  return (element instanceof HTMLButtonElement && element.disabled) ||
    element.getAttribute('aria-disabled') === 'true' ||
    /(?:^|\s)disabled(?:\s|$)/i.test(element.className)
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function highlight(element: HTMLElement): void {
  element.style.outline = '3px solid #22c55e'
  element.style.outlineOffset = '2px'
  setTimeout(() => {
    element.style.outline = ''
    element.style.outlineOffset = ''
  }, 2_000)
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

function stableSelector(element: Element): string {
  if (element.id) return `#${cssEscape(element.id)}`
  for (const attribute of ['data-testid', 'data-test', 'name', 'aria-label']) {
    const value = element.getAttribute(attribute)
    if (value) return `${element.tagName.toLowerCase()}[${attribute}="${cssEscape(value)}"]`
  }
  const parts: string[] = []
  let current: Element | null = element
  while (current && current !== document.body && parts.length < 6) {
    const parent: Element | null = current.parentElement
    const tag = current.tagName.toLowerCase()
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName)
    const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
    parts.unshift(`${tag}${suffix}`)
    current = parent
  }
  return `body > ${parts.join(' > ')}`
}

ipcRenderer.on('mexc:start-calibration', (_event, request: { kind: string }) => {
  const banner = document.createElement('div')
  banner.textContent = `ArbDesk校准：请点击 ${request.kind} 对应的网页元素（本次点击不会下单）`
  Object.assign(banner.style, {
    position: 'fixed',
    inset: '12px 12px auto 12px',
    zIndex: '2147483647',
    padding: '14px 18px',
    borderRadius: '10px',
    color: '#f8fafc',
    background: '#0f172a',
    border: '1px solid #22c55e',
    font: '600 14px system-ui',
    boxShadow: '0 12px 32px rgba(0,0,0,.35)'
  })
  document.documentElement.appendChild(banner)

  const select = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
    const target = event.target
    banner.remove()
    document.removeEventListener('click', select, true)
    if (!(target instanceof Element)) return
    highlight(target as HTMLElement)
    ipcRenderer.send('mexc:calibration-result', {
      kind: request.kind,
      selector: stableSelector(target)
    })
  }
  document.addEventListener('click', select, true)
})

ipcRenderer.on('mexc:prepare-order', async (_event, request: PrepareOrderRequest) => {
  const selectors = request.selectors ?? {}
  if (!Number.isFinite(Number(request.amount)) || Number(request.amount) <= 0) {
    ipcRenderer.send('mexc:automation-result', {
      ok: false,
      message: 'MEXC下单金额必须是大于0的数字；未操作网页',
      matched: {}
    })
    return
  }

  const directionSelector = request.direction === 'UP' ? selectors.upButton : selectors.downButton
  let amountInput = resolveAmountInput(selectors.amountInput, request.allowSemanticFallback)
  const directionButton = resolveDirectionButton(request.direction, directionSelector, request.allowSemanticFallback)
  let submitButton = resolveSubmitButton(undefined, selectors.submitButton, request.allowSemanticFallback)
  const matched = {
    amountInput: visible(amountInput),
    directionButton: visible(directionButton),
    submitButton: visible(submitButton),
    submitEnabled: false
  }

  if (!amountInput || !directionButton || !submitButton) {
    ipcRenderer.send('mexc:automation-result', {
      ok: false,
      message: request.allowSemanticFallback
        ? '系统未能识别完整的MEXC下单区；未执行任何点击，可切换到手动校准模式'
        : '手动校准元素未完整匹配；未执行任何点击',
      matched
    })
    return
  }

  directionButton.click()
  await new Promise((resolve) => setTimeout(resolve, 80))

  // MEXC会在切换方向后重绘下单区，因此需要重新取得金额框和方向对应的提交按钮。
  amountInput = resolveAmountInput(selectors.amountInput, request.allowSemanticFallback)
  submitButton = resolveSubmitButton(request.direction, selectors.submitButton, request.allowSemanticFallback)
  matched.amountInput = visible(amountInput)
  matched.submitButton = visible(submitButton)
  matched.submitEnabled = visible(submitButton) && !disabled(submitButton)
  if (!amountInput || !submitButton) {
    ipcRenderer.send('mexc:automation-result', {
      ok: false,
      message: '已切换涨跌方向，但MEXC重绘后未能识别金额框或买入按钮',
      matched
    })
    return
  }

  setNativeInputValue(amountInput, request.amount)
  highlight(amountInput)
  highlight(directionButton)
  highlight(submitButton)

  if (request.allowSubmit && !matched.submitEnabled) {
    ipcRenderer.send('mexc:automation-result', {
      ok: false,
      message: '已切换方向并填入金额，但MEXC买入按钮当前不可用，未强制点击',
      matched
    })
    return
  }
  if (request.allowSubmit) submitButton.click()
  ipcRenderer.send('mexc:automation-result', {
    ok: true,
    message: request.allowSubmit
      ? '已触发MEXC网页提交，请核对实际成交'
      : '已自动选择涨跌并填入金额，买入按钮已高亮，等待人工确认',
    matched
  })
})
