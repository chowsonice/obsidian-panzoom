import { App, PluginSettingTab, Setting } from 'obsidian';
import type MyPlugin from '../main';

export interface PanzoomSettings {
	minScale: number;
	maxScale: number;
	zoomStep: number;
	scrollDamping: number;
}

export const DEFAULT_SETTINGS: PanzoomSettings = {
	minScale: 1,
	maxScale: 5,
	zoomStep: 0.2,
	scrollDamping: 0.6,
};

export class PanzoomSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Panzoom settings' });

		new Setting(containerEl)
			.setName('Minimum zoom')
			.setDesc('Minimum zoom scale (default: 1)')
			.addSlider(slider => slider
				.setLimits(0.5, 2, 0.1)
				.setValue(this.plugin.settings.minScale)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.minScale = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button => button
				.setIcon('reset')
				.setTooltip('Reset to default')
				.onClick(async () => {
					this.plugin.settings.minScale = DEFAULT_SETTINGS.minScale;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Maximum zoom')
			.setDesc('Maximum zoom scale (default: 5)')
			.addSlider(slider => slider
				.setLimits(2, 20, 1)
				.setValue(this.plugin.settings.maxScale)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxScale = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button => button
				.setIcon('reset')
				.setTooltip('Reset to default')
				.onClick(async () => {
					this.plugin.settings.maxScale = DEFAULT_SETTINGS.maxScale;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Zoom step')
			.setDesc('How much to zoom per scroll step (default: 0.1)')
			.addSlider(slider => slider
				.setLimits(0.05, 0.5, 0.05)
				.setValue(this.plugin.settings.zoomStep)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.zoomStep = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button => button
				.setIcon('reset')
				.setTooltip('Reset to default')
				.onClick(async () => {
					this.plugin.settings.zoomStep = DEFAULT_SETTINGS.zoomStep;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Scroll damping')
			.setDesc('Scroll speed when zoomed in — lower is slower (default: 0.6)')
			.addSlider(slider => slider
				.setLimits(0.1, 1.0, 0.1)
				.setValue(this.plugin.settings.scrollDamping)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.scrollDamping = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button => button
				.setIcon('reset')
				.setTooltip('Reset to default')
				.onClick(async () => {
					this.plugin.settings.scrollDamping = DEFAULT_SETTINGS.scrollDamping;
					await this.plugin.saveSettings();
					this.display();
				}));
	}
}
