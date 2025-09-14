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

	constructor(app: App, manifest: any) {
		super(app, manifest);
		this.debouncedReinitialize = debounce(
			this.reinitializeIfNeeded.bind(this),
			MyPlugin.REINIT_DELAY,
			true
		);
	}

	async onload(): Promise<void> {
		// Attendre que le workspace soit prêt pour éviter d'impacter le temps de chargement
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

	private createPanzoomInstance(viewContent: HTMLElement): void {
		if (!viewContent || this.viewContentMap.has(viewContent)) return;

		try {
			const panzoomInstance = Panzoom(viewContent, MyPlugin.PANZOOM_CONFIG);
			const cmScroller = viewContent.querySelector(MyPlugin.CM_SCROLLER_SELECTOR) as HTMLElement;
			const eventHandlers = this.createEventHandlers(panzoomInstance, cmScroller);
			
			const viewData: ViewContentData = {
				panzoomInstance,
				eventHandlers,
				cmScroller
			};
			
			this.viewContentMap.set(viewContent, viewData);
			this.bindEvents(viewContent, eventHandlers);
		} catch (error) {
			console.error('Erreur lors de l\'initialisation de Panzoom:', error);
		}
	}

	private createEventHandlers(
		panzoomInstance: PanzoomObject, 
		cmScroller: HTMLElement | null
	): EventHandlers {
		return {
			handleWheel: this.createWheelHandler(panzoomInstance, cmScroller)
		};
	}

	private createWheelHandler(panzoomInstance: PanzoomObject, cmScroller: HTMLElement | null) {
		return (event: WheelEvent) => {
			if (!panzoomInstance) return;

			event.preventDefault();
			
			if (event.ctrlKey) {
				this.handleZoom(event, panzoomInstance);
			} else {
				this.handlePanAndScroll(event, panzoomInstance, cmScroller);
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

	private handlePanAndScroll(event: WheelEvent, panzoomInstance: PanzoomObject, cmScroller: HTMLElement | null): void {
		const { deltaX = 0, deltaY = 0 } = event;
		
		this.applyPanning(deltaX, deltaY, panzoomInstance);
		this.applyCmScrolling(deltaX, deltaY, cmScroller);
	}

	private applyPanning(deltaX: number, deltaY: number, panzoomInstance: PanzoomObject): void {
		const currentPan = panzoomInstance.getPan();
		panzoomInstance.pan(
			currentPan.x - deltaX,
			currentPan.y - deltaY,
			{ relative: false }
		);
	}

	private applyCmScrolling(deltaX: number, deltaY: number, cmScroller: HTMLElement | null): void {
		cmScroller?.scrollBy({
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

// class SampleSettingTab extends PluginSettingTab {
// 	plugin: MyPlugin;

// 	constructor(app: App, plugin: MyPlugin) {
// 		super(app, plugin);
// 		this.plugin = plugin;
// 	}

// 	display(): void {
// 		const { containerEl } = this;
// 		containerEl.empty();
// 	}
// }
