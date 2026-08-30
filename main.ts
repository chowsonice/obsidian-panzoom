import { App, Plugin, MarkdownView, WorkspaceLeaf, debounce } from 'obsidian';
import Panzoom, { PanzoomObject } from '@panzoom/panzoom';
import { PanzoomSettings, DEFAULT_SETTINGS, PanzoomSettingTab } from './src/settings';

interface LeafPanzoomData {
    panzoom: PanzoomObject;
    handleWheel: (e: WheelEvent) => void;
    targetEl: HTMLElement;
}

export default class PanzoomPlugin extends Plugin {
    settings: PanzoomSettings;
    private readonly activeLeaves = new Map<WorkspaceLeaf, LeafPanzoomData>();
    private readonly debouncedRefresh: () => void;

    private static readonly ZOOM_THRESHOLD_LOW = 1.1;
    private static readonly ZOOM_THRESHOLD_HIGH = 1.2;

    constructor(app: App, manifest: any) {
        super(app, manifest);
        // Debounce the refresh to avoid performance drops during rapid layout changes
        this.debouncedRefresh = debounce(this.refreshLeaves.bind(this), 100, true);
    }

    async onload(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addSettingTab(new PanzoomSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.refreshLeaves();
            
            // Listen to standard Obsidian workspace events instead of a global MutationObserver
            this.registerEvent(this.app.workspace.on('layout-change', this.debouncedRefresh));
            this.registerEvent(this.app.workspace.on('active-leaf-change', this.debouncedRefresh));
        });
    }

    private refreshLeaves(): void {
        const currentLeaves = new Set<WorkspaceLeaf>();

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                currentLeaves.add(leaf);
                
                if (!this.activeLeaves.has(leaf)) {
                    this.attachPanzoom(leaf, leaf.view);
                } else {
                    // Update existing Panzoom instance based on current view mode
                    const data = this.activeLeaves.get(leaf);
                    const isPreview = leaf.view.getMode() === 'preview';
                    if (data) {
                        data.panzoom.setOptions({
                            // Allow mobile panning in preview, disable in edit for text selection
                            disablePan: !isPreview 
                        });
                    }
                }
            }
        });

        // Cleanup leaves that were closed or are no longer markdown views
        for (const [leaf, data] of this.activeLeaves) {
            if (!currentLeaves.has(leaf)) {
                this.detachPanzoom(leaf, data);
            }
        }
    }

    private attachPanzoom(leaf: WorkspaceLeaf, view: MarkdownView): void {
        const targetEl = view.contentEl;
        if (!targetEl) return;

        const isPreview = view.getMode() === 'preview';

        const panzoom = Panzoom(targetEl, {
            // noBind is omitted so Panzoom binds native touch/pointer events for mobile
            minScale: this.settings.minScale,
            maxScale: this.settings.maxScale,
            contain: 'inside',
            disableZoom: false,
            cursor: 'default',
            step: this.settings.zoomStep,
            
            // Critical for Mobile: prevents native browser swiping from overriding panzoom
            touchAction: 'none',
            
            // Initial pan state based on mode
            disablePan: !isPreview 
        });

        // Custom Desktop Wheel Logic
        const handleWheel = (event: WheelEvent) => {
            const scale = panzoom.getScale();

            if (event.ctrlKey) {
                // Desktop Zooming
                event.preventDefault();
                const isZoomingIn = event.deltaY < 0;
                const currentContain = panzoom.getOptions().contain;

                // Adjust contain behavior to prevent edge-snapping at low zooms
                if (scale <= PanzoomPlugin.ZOOM_THRESHOLD_LOW && currentContain === 'inside' && isZoomingIn) {
                    panzoom.setOptions({ contain: 'outside' });
                } else if (scale <= PanzoomPlugin.ZOOM_THRESHOLD_HIGH && currentContain === 'outside' && !isZoomingIn) {
                    panzoom.setOptions({ contain: 'inside' });
                }

                panzoom.zoomWithWheel(event);
            } else if (scale > 1) {
                // Desktop Panning when zoomed in
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

        targetEl.addEventListener('wheel', handleWheel, { passive: false });
        this.activeLeaves.set(leaf, { panzoom, handleWheel, targetEl });
    }

    private detachPanzoom(leaf: WorkspaceLeaf, data: LeafPanzoomData): void {
        data.targetEl.removeEventListener('wheel', data.handleWheel);
        data.panzoom.destroy();
        this.activeLeaves.delete(leaf);
    }

    onunload(): void {
        for (const [leaf, data] of this.activeLeaves) {
            this.detachPanzoom(leaf, data);
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        
        // Dynamically update settings without destroying Panzoom state
        for (const { panzoom } of this.activeLeaves.values()) {
            panzoom.setOptions({
                minScale: this.settings.minScale,
                maxScale: this.settings.maxScale,
                step: this.settings.zoomStep
            });
        }
    }
}