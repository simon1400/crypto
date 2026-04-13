import { DrawingManager, getToolRegistry, SerializedDrawing } from 'lightweight-charts-drawing'
import { safeParse } from '../utils/safeParse'

function getStorageKey(sym: string): string {
  return `drawings_${sym}`
}

function saveDrawings(manager: DrawingManager, sym: string): void {
  try {
    const data = manager.exportDrawings()
    localStorage.setItem(getStorageKey(sym), JSON.stringify(data))
  } catch (e) {
    console.warn('[Backtester] Failed to save drawings:', e)
  }
}

function loadDrawings(manager: DrawingManager, sym: string): void {
  try {
    const raw = localStorage.getItem(getStorageKey(sym))
    if (!raw) return
    const data: SerializedDrawing[] = safeParse<SerializedDrawing[]>(raw, [], 'Backtester:drawings')
    if (data.length === 0) return
    const registry = getToolRegistry()
    manager.importDrawings(data, (type: string, d: any) => {
      return registry.createDrawing(type, d.id, d.anchors, d.style, d.options)
    })
  } catch (e) {
    console.warn('[Backtester] Failed to load drawings:', e)
  }
}

export function useDrawingPersistence() {
  return { saveDrawings, loadDrawings, getStorageKey }
}
