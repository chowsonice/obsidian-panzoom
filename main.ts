import { App, Plugin, debounce } from 'obsidian';
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

export default class MyPlugin extends Plugin {
    settings: PanzoomSettings;
    private readonly viewContentMap = new Map<HTMLElement, ViewContentData>();
    private observer: MutationObserver | null = null;
    private readonly debouncedReinitialize: () => void;

	private getPanDirection(deltaX: number, deltaY: number): 'horizontal' | 'vertical' | 'none' {
		if (deltaX === 0 && deltaY === 0) return 'none';
		// If the horizontal movement is greater than vertical, they are panning horizontally
		return Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
	}

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

    private static readonly OBSERVER_CONFIG: MutationObserverInit = {
        childList: true,
        subtree: true
    };

    // Zoom thresholds for contain switching
    private static readonly ZOOM_THRESHOLD_LOW = 1.1;
    private static readonly ZOOM_THRESHOLD_HIGH = 1.2;
    private static readonly REINIT_DELAY = 150; // Increased for better performance

    // Selectors
    private static readonly VIEW_CONTENT_SELECTOR = '.view-content';
    private static readonly CM_SCROLLER_SELECTOR = '.cm-scroller';
    private static readonly PREVIEW_VIEW_CLASS = 'markdown-preview-view';

    constructor(app: App, manifest: any) {
        super(app, manifest);
        this.debouncedReinitialize = debounce(
            this.reinitializeIfNeeded.bind(this),
            MyPlugin.REINIT_DELAY,
            true
        );
    }

    async onload(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addSettingTab(new PanzoomSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.initializeAllPanzoom();
            this.setupObserver();
            this.setupWorkspaceListeners();
        });
    }

    private initializeAllPanzoom(): void {
        const viewContents = this.getAllVisibleViewContents();
        for (const viewContent of viewContents) {
            if (!this.viewContentMap.has(viewContent)) {
                this.createPanzoomInstance(viewContent);
            }
        }
    }

    private getAllVisibleViewContents(): HTMLElement[] {
        return Array.from(document.querySelectorAll(MyPlugin.VIEW_CONTENT_SELECTOR))
            .filter((element): element is HTMLElement => {
                if (!(element instanceof HTMLElement)) return false;
                if (!this.isElementVisible(element)) return false;
                
                // Exclure les leafs PDF - vérifier si le parent a data-type="pdf"
                const leafContent = element.parentElement;
                if (leafContent && 
                    leafContent.classList.contains('workspace-leaf-content') && 
                    leafContent.getAttribute('data-type') === 'pdf') {
                    return false;
                }
                
                return true;
            });
    }

    private isElementVisible(element: HTMLElement): boolean {
        return document.contains(element) && 
               window.getComputedStyle(element).display !== 'none';
    }

    private getViewMode(viewContent: HTMLElement): 'edit' | 'preview' {
        const leafContent = viewContent.closest('.workspace-leaf-content');
        const dataMode = leafContent?.getAttribute('data-mode');
        return dataMode === 'preview' ? 'preview' : 'edit';
    }

    private createPanzoomInstance(viewContent: HTMLElement): void {
        if (!viewContent || this.viewContentMap.has(viewContent)) return;

        try {
			// 1. ADD THESE CSS RULES BEFORE PANZOOM INITIALIZES
			viewContent.style.transformOrigin = '0 0';
			viewContent.style.willChange = 'transform'; // Forces hardware acceleration
			viewContent.style.backfaceVisibility = 'hidden'; // Prevents pixel rounding glitches
			
            const panzoomInstance = Panzoom(viewContent, this.panzoomConfig);
            const cmScroller = viewContent.querySelector(MyPlugin.CM_SCROLLER_SELECTOR) as HTMLElement;
            const previewScroller = viewContent.querySelector('.' + MyPlugin.PREVIEW_VIEW_CLASS) as HTMLElement;
            const eventHandlers = this.createEventHandlers(panzoomInstance, cmScroller, previewScroller, viewContent);
            
            const viewData: ViewContentData = {
                panzoomInstance,
                eventHandlers,
                cmScroller,
                previewScroller
            };
            
            this.viewContentMap.set(viewContent, viewData);
            this.bindEvents(viewContent, eventHandlers);
        } catch (error) {
            console.error('Erreur lors de l\'initialisation de Panzoom:', error);
        }
    }

    private createEventHandlers(
        panzoomInstance: PanzoomObject, 
        cmScroller: HTMLElement | null,
        previewScroller: HTMLElement | null,
        viewContent: HTMLElement
    ): EventHandlers {
        
        // --- TOUCH STATE CLOSURE ---
        let initialPinchDistance = 0;
        let lastPanPosition = { x: 0, y: 0 };
        let touchState: 'none' | 'panning' | 'pinching' = 'none';

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                touchState = 'pinching';
                e.preventDefault(); 
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                initialPinchDistance = Math.hypot(dx, dy);
            } else if (e.touches.length === 1 && panzoomInstance.getScale() > 1.01) {
                touchState = 'panning';
                lastPanPosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            } else {
                touchState = 'none';
            }
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

                const currentScale = panzoomInstance.getScale();
                const zoomFactor = distance / initialPinchDistance;
                const newScale = currentScale * zoomFactor;
                
                panzoomInstance.zoomToPoint(newScale, center, { animate: false });
                initialPinchDistance = distance; 

            } else if (touchState === 'panning' && e.touches.length === 1) {
				e.preventDefault(); 
				const currentX = e.touches[0].clientX;
				const currentY = e.touches[0].clientY;
				
				const scale = panzoomInstance.getScale();
				
				const rawDeltaX = lastPanPosition.x - currentX;
				const rawDeltaY = lastPanPosition.y - currentY;
				
				const damping = this.settings.scrollDamping || 1;
				const adjustedDeltaX = Math.round((rawDeltaX / scale) * damping);
				const adjustedDeltaY = Math.round((rawDeltaY / scale) * damping);
				
				const mode = this.getViewMode(viewContent);
				const scroller = mode === 'preview' ? previewScroller : cmScroller;

				// Detect primary direction
				const direction = this.getPanDirection(rawDeltaX, rawDeltaY);

				if (direction === 'horizontal') {
					this.applyPanning(adjustedDeltaX, 0, panzoomInstance);
				} else if (direction === 'vertical') {
					this.applyScrolling(0, adjustedDeltaY, scroller);
				}
				
				lastPanPosition = { x: currentX, y: currentY };
			}
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2 && touchState === 'pinching') {
                if (e.touches.length === 1 && panzoomInstance.getScale() > 1.01) {
                    touchState = 'panning';
                    lastPanPosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                } else {
                    touchState = 'none';
                }
            } else if (e.touches.length === 0) {
                touchState = 'none';
            }
        };

        return {
            handleWheel: this.createWheelHandler(panzoomInstance, cmScroller, previewScroller, viewContent),
            handleTouchStart,
            handleTouchMove,
            handleTouchEnd
        };
    }

    private createWheelHandler(panzoomInstance: PanzoomObject, cmScroller: HTMLElement | null, previewScroller: HTMLElement | null, viewContent: HTMLElement) {
        return (event: WheelEvent) => {
            const mode = this.getViewMode(viewContent);
            if (!panzoomInstance) return;

            const currentScale = panzoomInstance.getScale();
            const isPreview = mode === 'preview';
            const scroller = isPreview ? previewScroller : cmScroller;

            if (event.ctrlKey) {
                event.preventDefault();
                this.handleZoom(event, panzoomInstance);
            } else if (currentScale > 1) {
                event.preventDefault();
                this.handlePanAndScroll(event, panzoomInstance, scroller);
            }
        };
    }

    private handleZoom(event: WheelEvent, panzoomInstance: PanzoomObject): void {
        const currentScale = panzoomInstance.getScale();
        const currentContain = panzoomInstance.getOptions().contain || 'inside';
        const isZoomingIn = event.deltaY < 0;
        
        this.updateContainForZoom(panzoomInstance, currentScale, currentContain, isZoomingIn);
        panzoomInstance.zoomWithWheel(event);
    }

    private updateContainForZoom(
        panzoomInstance: PanzoomObject, 
        currentScale: number, 
        currentContain: string, 
        isZoomingIn: boolean
    ): void {
        if (currentScale <= MyPlugin.ZOOM_THRESHOLD_LOW && currentContain === 'inside' && isZoomingIn) {
            panzoomInstance.setOptions({ contain: 'outside' });
        } else if (currentScale <= MyPlugin.ZOOM_THRESHOLD_HIGH && currentContain === 'outside' && !isZoomingIn) {
            panzoomInstance.setOptions({ contain: 'inside' });
        }
    }

    private handlePanAndScroll(event: WheelEvent, panzoomInstance: PanzoomObject, scroller: HTMLElement | null): void {
		const { deltaX = 0, deltaY = 0 } = event;
		const scale = panzoomInstance.getScale();
		const damping = this.settings.scrollDamping || 1;
		
		const adjustedDeltaX = Math.round((deltaX / scale) * damping);
		const adjustedDeltaY = Math.round((deltaY / scale) * damping);
		
		const direction = this.getPanDirection(adjustedDeltaX, adjustedDeltaY);

		if (direction === 'horizontal') {
			// Only pan the zoom container horizontally
			this.applyPanning(adjustedDeltaX, 0, panzoomInstance);
		} else if (direction === 'vertical') {
			// Only scroll the document vertically
			this.applyScrolling(0, adjustedDeltaY, scroller);
		}
	}

    private applyPanning(deltaX: number, deltaY: number, panzoomInstance: PanzoomObject): void {
        const currentPan = panzoomInstance.getPan();
        panzoomInstance.pan(
            currentPan.x - deltaX,
            currentPan.y - deltaY,
            { relative: false }
        );
    }

    private applyScrolling(deltaX: number, deltaY: number, scroller: HTMLElement | null): void {
        scroller?.scrollBy({
            left: deltaX,
            top: deltaY,
            behavior: 'auto'
        });
    }

    private bindEvents(viewContent: HTMLElement, eventHandlers: EventHandlers): void {
        viewContent.addEventListener('wheel', eventHandlers.handleWheel, { passive: false });
        viewContent.addEventListener('touchstart', eventHandlers.handleTouchStart, { passive: false });
        viewContent.addEventListener('touchmove', eventHandlers.handleTouchMove, { passive: false });
        viewContent.addEventListener('touchend', eventHandlers.handleTouchEnd, { passive: false });
        // Handle touch canceling (e.g. user minimizing app while dragging)
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
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', this.debouncedReinitialize)
        );
        this.registerEvent(
            this.app.workspace.on('layout-change', this.debouncedReinitialize)
        );
        this.registerEvent(
            this.app.workspace.on('file-open', this.debouncedReinitialize)
        );
    }

    private reinitializeIfNeeded(): void {
        if (!this.app.workspace.layoutReady) return;
        
        this.cleanupInvalidInstances();
        this.initializeAllPanzoom();
    }

    private cleanupInvalidInstances(): void {
        for (const [viewContent, viewData] of this.viewContentMap) {
            if (!this.isElementVisible(viewContent)) {
                this.cleanupSingleInstance(viewContent);
            }
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
        for (const [viewContent] of this.viewContentMap) {
            this.cleanupSingleInstance(viewContent);
        }
        this.viewContentMap.clear();
    }

    onunload(): void {
        this.observer?.disconnect();
        this.cleanup();
        this.observer = null;
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.cleanup();
        this.initializeAllPanzoom();
    }
}