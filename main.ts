import { App, Plugin, MarkdownView, WorkspaceLeaf, debounce } from 'obsidian';
import Panzoom, { PanzoomObject } from '@panzoom/panzoom';
import { PanzoomSettings, DEFAULT_SETTINGS, PanzoomSettingTab } from './src/settings';

interface LeafPanzoomData {
    panzoom: PanzoomObject;
    targetEl: HTMLElement;
    handlers: {
        wheel: (e: WheelEvent) => void;
        touchstart: (e: TouchEvent) => void;
        touchmove: (e: TouchEvent) => void;
        touchend: (e: TouchEvent) => void;
    };
}

export default class PanzoomPlugin extends Plugin {
    settings: PanzoomSettings;
    private readonly activeLeaves = new Map<WorkspaceLeaf, LeafPanzoomData>();
    private readonly debouncedRefresh: () => void;
    private debugEl: HTMLElement | null = null; // Visual Debugger Element

    private static readonly ZOOM_THRESHOLD_LOW = 1.1;
    private static readonly ZOOM_THRESHOLD_HIGH = 1.2;

    constructor(app: App, manifest: any) {
        super(app, manifest);
        this.debouncedRefresh = debounce(this.refreshLeaves.bind(this), 100, true);
    }

    async onload(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addSettingTab(new PanzoomSettingTab(this.app, this));
        
        this.initDebugOverlay(); // Start visual debugger

        this.app.workspace.onLayoutReady(() => {
            this.refreshLeaves();
            this.registerEvent(this.app.workspace.on('layout-change', this.debouncedRefresh));
            this.registerEvent(this.app.workspace.on('active-leaf-change', this.debouncedRefresh));
        });
    }

    // --- VISUAL DEBUGGER LOGIC ---
    private initDebugOverlay() {
        this.debugEl = document.createElement('div');
        Object.assign(this.debugEl.style, {
            position: 'absolute',
            bottom: '20px',
            right: '20px',
            background: 'rgba(0, 0, 0, 0.85)',
            color: '#0f0',
            padding: '12px',
            borderRadius: '8px',
            zIndex: '99999',
            fontFamily: 'monospace',
            fontSize: '12px',
            pointerEvents: 'none', // So it doesn't block touches
            whiteSpace: 'pre-wrap',
            minWidth: '200px'
        });
        document.body.appendChild(this.debugEl);
        this.updateDebug('Waiting for touch events...');
    }

    private updateDebug(message: string | object) {
        if (!this.debugEl) return;
        if (typeof message === 'object') {
            this.debugEl.textContent = Object.entries(message)
                .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(3) : v}`)
                .join('\n');
            console.log('Panzoom Debug:', message);
        } else {
            this.debugEl.textContent = message;
        }
    }
    // ----------------------------

    private refreshLeaves(): void {
        const currentLeaves = new Set<WorkspaceLeaf>();

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                currentLeaves.add(leaf);
                if (!this.activeLeaves.has(leaf)) {
                    this.attachPanzoom(leaf, leaf.view);
                }
            }
        });

        for (const [leaf, data] of this.activeLeaves) {
            if (!currentLeaves.has(leaf)) {
                this.detachPanzoom(leaf, data);
            }
        }
    }

    private attachPanzoom(leaf: WorkspaceLeaf, view: MarkdownView): void {
        const targetEl = view.contentEl;
        if (!targetEl) return;

        const panzoom = Panzoom(targetEl, {
            noBind: true, 
            minScale: this.settings.minScale,
            maxScale: this.settings.maxScale,
            contain: 'inside',
            disableZoom: false,
            cursor: 'default',
            step: this.settings.zoomStep
        });

        // --- DESKTOP WHEEL LOGIC ---
        const handleWheel = (event: WheelEvent) => {
            const scale = panzoom.getScale();
            if (event.ctrlKey) {
                event.preventDefault();
                const isZoomingIn = event.deltaY < 0;
                const currentContain = panzoom.getOptions().contain;

                if (scale <= PanzoomPlugin.ZOOM_THRESHOLD_LOW && currentContain === 'inside' && isZoomingIn) {
                    panzoom.setOptions({ contain: 'outside' });
                } else if (scale <= PanzoomPlugin.ZOOM_THRESHOLD_HIGH && currentContain === 'outside' && !isZoomingIn) {
                    panzoom.setOptions({ contain: 'inside' });
                }
                panzoom.zoomWithWheel(event);
            } else if (scale > 1) {
                event.preventDefault();
                const damping = this.settings.scrollDamping ?? 1;
                const currentPan = panzoom.getPan();
                panzoom.pan(
                    currentPan.x - Math.round((event.deltaX / scale) * damping),
                    currentPan.y - Math.round((event.deltaY / scale) * damping),
                    { relative: false }
                );
            }
        };

// --- MOBILE TOUCH LOGIC ---
        let initialPinchDistance = 0;
        let initialScale = 1; // NEW: Track the scale at the exact moment the pinch starts
        let lastPanPosition = { x: 0, y: 0 };
        let touchState: 'none' | 'panning' | 'pinching' = 'none';

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                touchState = 'pinching';
                e.preventDefault(); 
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                initialPinchDistance = Math.hypot(dx, dy);
                initialScale = panzoom.getScale(); // Record scale at start of pinch
            } else if (e.touches.length === 1 && panzoom.getScale() > 1.01) {
                touchState = 'panning';
                lastPanPosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            } else {
                touchState = 'none';
            }

            this.updateDebug({
                Event: 'TouchStart',
                Fingers: e.touches.length,
                State: touchState,
                StartScale: initialScale
            });
        };

const handleTouchMove = (e: TouchEvent) => {
            if (touchState === 'pinching' && e.touches.length === 2) {
                e.preventDefault(); 
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const distance = Math.hypot(dx, dy);
                
                const center = {
                    clientX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                    clientY: (e.touches[0].clientY + e.touches[1].clientY) / 2
                };

                const zoomFactor = distance / initialPinchDistance;
                const newScale = initialScale * zoomFactor;
                
                // --- CRITICAL FIX: CONTAINMENT TOGGLING ---
                // We must switch to contain: 'outside' so Panzoom actually allows the element to grow
                const currentScale = panzoom.getScale();
                const isZoomingIn = newScale > currentScale;
                const currentContain = panzoom.getOptions().contain;

                if (currentScale <= PanzoomPlugin.ZOOM_THRESHOLD_LOW && currentContain === 'inside' && isZoomingIn) {
                    panzoom.setOptions({ contain: 'outside' });
                } else if (currentScale <= PanzoomPlugin.ZOOM_THRESHOLD_HIGH && currentContain === 'outside' && !isZoomingIn) {
                    panzoom.setOptions({ contain: 'inside' });
                }
                // ------------------------------------------

                panzoom.zoomToPoint(newScale, center, { animate: false });
                
                this.updateDebug({
                    Event: 'TouchMove (Pinch)',
                    TotalZoomFactor: zoomFactor,
                    TargetScale: newScale,
                    ActualScale: panzoom.getScale() // This should now successfully follow TargetScale!
                });

            } else if (touchState === 'panning' && e.touches.length === 1) {
                e.preventDefault(); 
                const currentX = e.touches[0].clientX;
                const currentY = e.touches[0].clientY;
                
                const scale = panzoom.getScale();
                const deltaX = (currentX - lastPanPosition.x) / scale;
                const deltaY = (currentY - lastPanPosition.y) / scale;
                
                const currentPan = panzoom.getPan();
                panzoom.pan(
                    currentPan.x + deltaX,
                    currentPan.y + deltaY,
                    { animate: false, relative: false }
                );
                
                lastPanPosition = { x: currentX, y: currentY };
            }
        };
 
        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2 && touchState === 'pinching') {
                if (e.touches.length === 1 && panzoom.getScale() > 1.01) {
                    touchState = 'panning';
                    lastPanPosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                } else {
                    touchState = 'none';
                }
            } else if (e.touches.length === 0) {
                touchState = 'none';
            }

            this.updateDebug({
                Event: 'TouchEnd',
                RemainingFingers: e.touches.length,
                NewState: touchState
            });
        };

        // Bind all events
        targetEl.addEventListener('wheel', handleWheel, { passive: false });
        targetEl.addEventListener('touchstart', handleTouchStart, { passive: false });
        targetEl.addEventListener('touchmove', handleTouchMove, { passive: false });
        targetEl.addEventListener('touchend', handleTouchEnd, { passive: false });
        targetEl.addEventListener('touchcancel', handleTouchEnd, { passive: false });

        this.activeLeaves.set(leaf, { 
            panzoom, 
            targetEl, 
            handlers: { wheel: handleWheel, touchstart: handleTouchStart, touchmove: handleTouchMove, touchend: handleTouchEnd } 
        });
    }

    private detachPanzoom(leaf: WorkspaceLeaf, data: LeafPanzoomData): void {
        data.targetEl.removeEventListener('wheel', data.handlers.wheel);
        data.targetEl.removeEventListener('touchstart', data.handlers.touchstart);
        data.targetEl.removeEventListener('touchmove', data.handlers.touchmove);
        data.targetEl.removeEventListener('touchend', data.handlers.touchend);
        data.targetEl.removeEventListener('touchcancel', data.handlers.touchend);
        data.panzoom.destroy();
        this.activeLeaves.delete(leaf);
    }

    onunload(): void {
        for (const [leaf, data] of this.activeLeaves) {
            this.detachPanzoom(leaf, data);
        }
        // Remove visual debugger
        if (this.debugEl && this.debugEl.parentElement) {
            this.debugEl.parentElement.removeChild(this.debugEl);
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        for (const { panzoom } of this.activeLeaves.values()) {
            panzoom.setOptions({
                minScale: this.settings.minScale,
                maxScale: this.settings.maxScale,
                step: this.settings.zoomStep
            });
        }
    }
}