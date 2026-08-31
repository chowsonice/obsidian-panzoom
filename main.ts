import { App, Plugin, debounce, MarkdownView } from 'obsidian';
import Panzoom, { PanzoomObject } from '@panzoom/panzoom';
import { PanzoomSettings, DEFAULT_SETTINGS, PanzoomSettingTab } from './src/settings';

interface EventHandlers {
    handleWheel: (event: WheelEvent) => void;
    handleTouchStart: (event: TouchEvent) => void;
    handleTouchMove: (event: TouchEvent) => void;
    handleTouchEnd: (event: TouchEvent) => void;
}

interface PanzoomConfig {
    noBind: true;
    minScale: number;
    maxScale: number;
    contain: 'inside' | 'outside';
    disableZoom: boolean;
    cursor: string;
    step: number;
}

interface ViewContentData {
    panzoomInstance: PanzoomObject;
    eventHandlers: EventHandlers;
    cmScroller: HTMLElement | null;
    previewScroller: HTMLElement | null;
}

function getScreenDirection(): 'horizontal' | 'vertical' {
    return window.innerWidth > window.innerHeight ? 'horizontal' : 'vertical';
}


export default class MyPlugin extends Plugin {
    settings: PanzoomSettings;
    private readonly viewContentMap = new Map<HTMLElement, ViewContentData>();
    private observer: MutationObserver | null = null;
    private readonly debouncedReinitialize: () => void;
    
    private getPanDirection(deltaX: number, deltaY: number): 'horizontal' | 'vertical' | 'none' {
        if (deltaX === 0 && deltaY === 0) return 'none';
        if (getScreenDirection() == 'horizontal') {
            return Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
        } else {
            return Math.abs(deltaX) > Math.abs(deltaY) ? 'vertical' : 'horizontal';
        }
    }

    // Debugger Element
    private debugEl: HTMLElement | null = null;

    // Configuration constants
    private get panzoomConfig(): PanzoomConfig {
        return {
            noBind: true,
            minScale: this.settings.minScale,
            maxScale: this.settings.maxScale,
            contain: 'inside',
            disableZoom: false,
            cursor: 'default',
            step: this.settings.zoomStep
        };
    }

    private static readonly OBSERVER_CONFIG: MutationObserverInit = { childList: true, subtree: true };
    private static readonly SNAP_SCALE = 1.02; // Unified snap threshold for all zooming
    private static readonly REINIT_DELAY = 150; 
    private static readonly VIEW_CONTENT_SELECTOR = '.view-content';
    private static readonly CM_SCROLLER_SELECTOR = '.cm-scroller';
    private static readonly PREVIEW_VIEW_CLASS = 'markdown-preview-view';

    constructor(app: App, manifest: any) {
        super(app, manifest);
        this.debouncedReinitialize = debounce(this.reinitializeIfNeeded.bind(this), MyPlugin.REINIT_DELAY, true);
    }

    async onload(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addSettingTab(new PanzoomSettingTab(this.app, this));
        this.initDebugOverlay();

        this.app.workspace.onLayoutReady(() => {
            this.initializeAllPanzoom();
            this.setupObserver();
            this.setupWorkspaceListeners();
        });
    }

    // --- VISUAL DEBUGGER LOGIC ---
    private initDebugOverlay() {
        this.debugEl = document.createElement('div');
        Object.assign(this.debugEl.style, {
            position: 'absolute', bottom: '20px', right: '20px', background: 'rgba(0, 0, 0, 0.85)',
            color: '#0f0', padding: '12px', borderRadius: '8px', zIndex: '99999',
            fontFamily: 'monospace', fontSize: '12px', pointerEvents: 'none',
            whiteSpace: 'pre-wrap', minWidth: '200px'
        });
        document.body.appendChild(this.debugEl);
        this.updateDebug('Waiting for events...');
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

    private initializeAllPanzoom(): void {
        const viewContents = this.getAllVisibleViewContents();
        for (const viewContent of viewContents) {
            if (!this.viewContentMap.has(viewContent)) this.createPanzoomInstance(viewContent);
        }
    }

    private getAllVisibleViewContents(): HTMLElement[] {
        return Array.from(document.querySelectorAll(MyPlugin.VIEW_CONTENT_SELECTOR))
            .filter((element): element is HTMLElement => {
                if (!(element instanceof HTMLElement) || !this.isElementVisible(element)) return false;
                const leafContent = element.parentElement;
                return !(leafContent?.classList.contains('workspace-leaf-content') && leafContent.getAttribute('data-type') === 'pdf');
            });
    }

    private isElementVisible(element: HTMLElement): boolean {
        return document.contains(element) && window.getComputedStyle(element).display !== 'none';
    }

    private getViewMode(viewContent: HTMLElement): 'edit' | 'preview' {
        return viewContent.closest('.workspace-leaf-content')?.getAttribute('data-mode') === 'preview' ? 'preview' : 'edit';
    }

    private createPanzoomInstance(viewContent: HTMLElement): void {
        if (!viewContent || this.viewContentMap.has(viewContent)) return;

        try {
            viewContent.style.transformOrigin = '0 0';
            viewContent.style.willChange = 'transform';
            viewContent.style.backfaceVisibility = 'hidden'; 

            const panzoomInstance = Panzoom(viewContent, this.panzoomConfig);
            const cmScroller = viewContent.querySelector(MyPlugin.CM_SCROLLER_SELECTOR) as HTMLElement;
            const previewScroller = viewContent.querySelector('.' + MyPlugin.PREVIEW_VIEW_CLASS) as HTMLElement;
            const eventHandlers = this.createEventHandlers(panzoomInstance, cmScroller, previewScroller, viewContent);
            
            this.viewContentMap.set(viewContent, { panzoomInstance, eventHandlers, cmScroller, previewScroller });
            this.bindEvents(viewContent, eventHandlers);
        } catch (error) {
            console.error('Erreur lors de l\'initialisation de Panzoom:', error);
        }
    }

    // ==========================================
    // UNIFIED EXECUTION LOGIC (Touch + Desktop)
    // ==========================================

    /** Handles horizontal panning and vertical scrolling for both Touch and Mouse Wheel */
    private executePanOrScroll(rawDeltaX: number, rawDeltaY: number, panzoomInstance: PanzoomObject, scroller: HTMLElement | null): void {
        const scale = panzoomInstance.getScale();
        const damping = this.settings.scrollDamping || 1;
        
        const adjustedDeltaX = (rawDeltaX / scale) * damping;
        const adjustedDeltaY = (rawDeltaY / scale) * damping;
        
        const direction = this.getPanDirection(adjustedDeltaX, adjustedDeltaY);
        this.updateDebug({
            Event: 'PanDirection',
            ActualScale: direction
        });
        console.log('pan direction', direction)

        if (direction === 'horizontal') {
            const currentPan = panzoomInstance.getPan();
            panzoomInstance.pan(currentPan.x - adjustedDeltaX, currentPan.y, { relative: false });
        } else if (direction === 'vertical') {
            scroller?.scrollBy({ left: 0, top: adjustedDeltaY, behavior: 'auto' });
        }
    }

    /** 
     * Unified zoom application that manages the "snap to 1.0" behavior 
     * to prevent border stuttering and keep the logic DRY.
     */
    private applyZoomAndSnap(panzoomInstance: PanzoomObject, newScale: number, lastIntendedScale: number, center: { clientX: number, clientY: number }): void {
		// Check if the user's ACTUAL gesture is zooming in, regardless of the snapped scale
		const isZoomingIn = newScale > lastIntendedScale;

		if (newScale <= MyPlugin.SNAP_SCALE && !isZoomingIn) {
			if (panzoomInstance.getOptions().contain !== 'inside') {
				panzoomInstance.setOptions({ contain: 'inside' });
                console.log('contain -> inside', { newScale, currentPan: panzoomInstance.getPan() });
			}
			// Only trigger the snap if we aren't already at 1 to save performance
			if (panzoomInstance.getScale() !== 1) {
				panzoomInstance.zoom(1, { animate: false });
			}
		} else {
			if (panzoomInstance.getOptions().contain !== 'outside') {
				panzoomInstance.setOptions({ contain: 'outside' });
                console.log('contain -> outside', { newScale, currentPan: panzoomInstance.getPan() });
			}
			panzoomInstance.zoomToPoint(newScale, center, { animate: false });
		}
	}

    /** Translates a two-finger pinch gesture into a Panzoom zoom operation */
    private executeTouchZoom(touch1: Touch, touch2: Touch, initialScale: number, initialPinchDistance: number, panzoomInstance: PanzoomObject, lastIntendedScale: number): number {
		const dx = touch1.clientX - touch2.clientX;
		const dy = touch1.clientY - touch2.clientY;
		const currentDistance = Math.hypot(dx, dy);
		
		const center = {
			clientX: (touch1.clientX + touch2.clientX) / 2,
			clientY: (touch1.clientY + touch2.clientY) / 2
		};

		const distanceDelta = Math.abs(currentDistance - initialPinchDistance);
		const dynamicSpeedModifier = 1 + (distanceDelta * 0.002);
		
		let zoomFactor = currentDistance / initialPinchDistance;
		if (zoomFactor > 1) {
			zoomFactor *= dynamicSpeedModifier; 
		} else if (zoomFactor < 1) {
			zoomFactor /= dynamicSpeedModifier; 
		}

		const newScale = initialScale * zoomFactor;
		
		this.applyZoomAndSnap(panzoomInstance, newScale, lastIntendedScale, center);
		
		return newScale; // Return this to track the gesture frame-by-frame
	}

    // ==========================================
    // INPUT HANDLERS
    // ==========================================

	private createEventHandlers(
        panzoomInstance: PanzoomObject, cmScroller: HTMLElement | null, previewScroller: HTMLElement | null, viewContent: HTMLElement
    ): EventHandlers {
        
        // Touch Zoom State
        let initialPinchDistance = 0;
        let initialScale = 1; 
        let lastPanPosition = { x: 0, y: 0 };
        let touchState: 'none' | 'panning' | 'pinching' = 'none';
        let lastIntendedScale = 1; 

        // Trackpad / Wheel Zoom State
        let wheelGestureAccumulator = 0;
        let wheelGestureTimeout: ReturnType<typeof setTimeout> | null = null;
        
        // Touch Pan State (NEW)
        let touchPanAccumulator = 0;
        let touchPanTimeout: ReturnType<typeof setTimeout> | null = null;

        const getScroller = () => this.getViewMode(viewContent) === 'preview' ? previewScroller : cmScroller;

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                touchState = 'pinching';
                e.preventDefault(); 
                initialPinchDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                initialScale = panzoomInstance.getScale(); 
                lastIntendedScale = initialScale; 
            } else if (e.touches.length === 1 && panzoomInstance.getScale() > 1.01) {
                touchState = 'panning';
                lastPanPosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                touchPanAccumulator = 0; // Reset pan accumulator on new touch
            } else {
                touchState = 'none';
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (touchState === 'pinching' && e.touches.length === 2) {
                e.preventDefault(); 
                lastIntendedScale = this.executeTouchZoom(e.touches[0], e.touches[1], initialScale, initialPinchDistance, panzoomInstance, lastIntendedScale);

                this.updateDebug({
                    Event: 'TouchMove (Pinch)',
                    ActualScale: panzoomInstance.getScale()
                });

            } else if (touchState === 'panning' && e.touches.length === 1) {
                e.preventDefault(); 
                
                const currentX = e.touches[0].clientX;
                const currentY = e.touches[0].clientY;
                
                const rawDeltaX = lastPanPosition.x - currentX;
                const rawDeltaY = lastPanPosition.y - currentY;
                
                // 1. Calculate how far the finger moved this frame
                const distanceMoved = Math.hypot(rawDeltaX, rawDeltaY);
                touchPanAccumulator += distanceMoved;
                
                // 2. Reset the pan gesture if movement stops for 100ms
                if (touchPanTimeout) clearTimeout(touchPanTimeout);
                touchPanTimeout = setTimeout(() => {
                    touchPanAccumulator = 0;
                    requestCmMeasure();
                }, 100);

                // 3. Create a dynamic multiplier based on swipe length
                // The multiplier grows as the swipe gets longer (adjust 0.001 to taste)
                let panMultiplier = 1 + (touchPanAccumulator * 0.001);
                // Clamp it so it doesn't get wildly out of control on huge swipes (e.g., max 3x speed)
                panMultiplier = Math.min(panMultiplier, 3); 

                // 4. Apply the multiplier to the deltas
                const finalDeltaX = rawDeltaX * panMultiplier;
                const finalDeltaY = rawDeltaY * panMultiplier;

                this.executePanOrScroll(finalDeltaX, finalDeltaY, panzoomInstance, getScroller());
                
                lastPanPosition = { x: currentX, y: currentY };

                this.updateDebug({
                    Event: 'TouchMove (Pan)',
                    Accumulator: Math.round(touchPanAccumulator),
                    Multiplier: panMultiplier.toFixed(2)
                });
            }
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2 && touchState === 'pinching') {
                if (e.touches.length === 1 && panzoomInstance.getScale() > 1.01) {
                    touchState = 'panning';
                    lastPanPosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                    touchPanAccumulator = 0; // Reset pan accumulator when transitioning from pinch to pan
                } else {
                    touchState = 'none';
                }
            } else if (e.touches.length === 0) {
                touchState = 'none';
            }
        };

        const requestCmMeasure = () => {
            const leaves = this.app.workspace.getLeavesOfType('markdown');
            for (const leaf of leaves) {
                if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(viewContent)) {
                    const cmEditorView = (leaf.view.editor as any)?.cm;
                    if (cmEditorView) {
                        const scroller = cmEditorView.scrollDOM;
                        const scrollTop = scroller.scrollTop;
                        const scrollLeft = scroller.scrollLeft;

                        // prevent CSS smooth-scroll from animating the correction
                        const prevBehavior = scroller.style.scrollBehavior;
                        scroller.style.scrollBehavior = 'auto';

                        cmEditorView.requestMeasure();

                        // CM's requestMeasure write callback is scheduled via rAF.
                        // Since we call requestMeasure() FIRST, its rAF callback
                        // is registered before ours, so it runs first within the
                        // same frame — meaning we restore scroll BEFORE this
                        // frame paints. No visible intermediate state.
                        requestAnimationFrame(() => {
                            scroller.scrollTop = scrollTop;
                            scroller.scrollLeft = scrollLeft;
                            scroller.style.scrollBehavior = prevBehavior;
                        });
                    }
                    break;
                }
            }
        };
        const handleWheel = (event: WheelEvent) => {
            if (!panzoomInstance) return;

            if (event.ctrlKey) {
                event.preventDefault();
                
                wheelGestureAccumulator += Math.abs(event.deltaY);
                
                if (wheelGestureTimeout) clearTimeout(wheelGestureTimeout);
                wheelGestureTimeout = setTimeout(() => {
                    wheelGestureAccumulator = 0;
                    // measure only after the gesture settles
                    requestCmMeasure();
                }, 150);

                const baseStep = this.settings.zoomStep;
                const lengthMultiplier = 1 + (wheelGestureAccumulator * 0.3); 
                
                let dynamicStep = baseStep * lengthMultiplier;
                dynamicStep = Math.min(Math.max(dynamicStep, 0.01), 1); 
                
                const frameIntensity = Math.abs(event.deltaY) / 100;
                const currentScale = panzoomInstance.getScale();
                const direction = event.deltaY < 0 ? 1 : -1;
                
                const newScale = currentScale * Math.exp(direction * (dynamicStep * frameIntensity));
                const center = { clientX: event.clientX, clientY: event.clientY };
                
                this.applyZoomAndSnap(panzoomInstance, newScale, currentScale, center);
                const leaves = this.app.workspace.getLeavesOfType('markdown');
                
                this.updateDebug({
                    Event: 'Trackpad/Wheel Zoom',
                    GestureLength: Math.round(wheelGestureAccumulator),
                    DynamicStep: dynamicStep.toFixed(4),
                    ActualScale: panzoomInstance.getScale()
                });

            } else if (panzoomInstance.getScale() > 1) {
                event.preventDefault();
                this.executePanOrScroll(event.deltaX, event.deltaY, panzoomInstance, getScroller());
            }
        };

        return { handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd };
    }

    // ==========================================
    // LIFECYCLE & CLEANUP
    // ==========================================

    private bindEvents(viewContent: HTMLElement, eventHandlers: EventHandlers): void {
        viewContent.addEventListener('wheel', eventHandlers.handleWheel, { passive: false });
        viewContent.addEventListener('touchstart', eventHandlers.handleTouchStart, { passive: false });
        viewContent.addEventListener('touchmove', eventHandlers.handleTouchMove, { passive: false });
        viewContent.addEventListener('touchend', eventHandlers.handleTouchEnd, { passive: false });
        viewContent.addEventListener('touchcancel', eventHandlers.handleTouchEnd, { passive: false }); 
    }

    private unbindEvents(viewContent: HTMLElement, eventHandlers: EventHandlers): void {
        viewContent.removeEventListener('wheel', eventHandlers.handleWheel);
        viewContent.removeEventListener('touchstart', eventHandlers.handleTouchStart);
        viewContent.removeEventListener('touchmove', eventHandlers.handleTouchMove);
        viewContent.removeEventListener('touchend', eventHandlers.handleTouchEnd);
        viewContent.removeEventListener('touchcancel', eventHandlers.handleTouchEnd);
    }

    private setupObserver(): void {
        this.observer = new MutationObserver(this.handleDOMChanges.bind(this));
        this.observer.observe(document.body, MyPlugin.OBSERVER_CONFIG);
    }

    private setupWorkspaceListeners(): void {
        this.registerEvent(this.app.workspace.on('active-leaf-change', this.debouncedReinitialize));
        this.registerEvent(this.app.workspace.on('layout-change', this.debouncedReinitialize));
        this.registerEvent(this.app.workspace.on('file-open', this.debouncedReinitialize));
    }

    private reinitializeIfNeeded(): void {
        if (!this.app.workspace.layoutReady) return;
        this.cleanupInvalidInstances();
        this.initializeAllPanzoom();
    }

    private cleanupInvalidInstances(): void {
        for (const [viewContent, viewData] of this.viewContentMap) {
            if (!this.isElementVisible(viewContent)) this.cleanupSingleInstance(viewContent);
        }
    }

    private cleanupSingleInstance(viewContent: HTMLElement): void {
        const viewData = this.viewContentMap.get(viewContent);
        if (!viewData) return;
        
        this.unbindEvents(viewContent, viewData.eventHandlers);
        viewData.panzoomInstance.destroy();
        this.viewContentMap.delete(viewContent);
    }

    private handleDOMChanges(): void {
        if (!this.app.workspace.layoutReady) return;
        this.debouncedReinitialize();
    }

    private cleanup(): void {
        for (const [viewContent] of this.viewContentMap) this.cleanupSingleInstance(viewContent);
        this.viewContentMap.clear();
    }

    onunload(): void {
        this.observer?.disconnect();
        this.cleanup();
        this.observer = null;
        if (this.debugEl?.parentElement) this.debugEl.parentElement.removeChild(this.debugEl);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.cleanup();
        this.initializeAllPanzoom();
    }
}