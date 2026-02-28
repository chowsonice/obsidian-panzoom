import { App, Plugin, debounce } from 'obsidian';
import Panzoom, { PanzoomObject } from '@panzoom/panzoom';

interface EventHandlers {
	handleWheel: (event: WheelEvent) => void;
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
	private readonly viewContentMap = new Map<HTMLElement, ViewContentData>();
	private observer: MutationObserver | null = null;
	private readonly debouncedReinitialize: () => void;

	// Configuration constants
	private static readonly PANZOOM_CONFIG: PanzoomConfig = {
		noBind: true,
		minScale: 1,
		maxScale: 5,
		contain: 'inside', // Start with inside for better default behavior
		disableZoom: false,
		cursor: 'default',
		step: 0.1
	};

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
			const panzoomInstance = Panzoom(viewContent, MyPlugin.PANZOOM_CONFIG);
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
		return {
			handleWheel: this.createWheelHandler(panzoomInstance, cmScroller, previewScroller, viewContent)
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
				// Zoom: always intercept
				event.preventDefault();
				this.handleZoom(event, panzoomInstance);
			} else if (currentScale > 1) {
				// Panning + programmatic scroll only when zoomed in
				event.preventDefault();
				this.handlePanAndScroll(event, panzoomInstance, scroller);
			}
			// At scale 1 without Ctrl: let native scroll happen (no preventDefault)
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
		
		this.applyPanning(deltaX, deltaY, panzoomInstance);
		this.applyScrolling(deltaX, deltaY, scroller);
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
	}

	private unbindEvents(viewContent: HTMLElement, eventHandlers: EventHandlers): void {
		viewContent.removeEventListener('wheel', eventHandlers.handleWheel);
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
}
