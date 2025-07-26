import { synthesizeOpenAISpeech } from '$lib/apis/audio';
import { config, settings, TTSWorker } from '$lib/stores';
import { toast } from 'svelte-sonner';

import { getMessageContentParts } from '$lib/utils';
import { KokoroWorker } from '$lib/workers/KokoroWorker';
import type { i18n as i18nType } from 'i18next';
import { getContext } from 'svelte';
import type { Writable } from 'svelte/store';
import { get } from 'svelte/store';
import { v4 as uuidv4 } from 'uuid';

const i18n = getContext<Writable<i18nType>>('i18n');

export class TTSElement {
	_id: string;
	content: string;
	ssml: boolean;
	private abortController;

	private engine: 'webAPI' | 'browser-kokoro' | 'external' = 'webAPI';
	private webApiSpeak: undefined | SpeechSynthesisUtterance;
	private kokoroMessageContentParts: string[] = [];
	private kokoroPlayingAudio: undefined | HTMLAudioElement;
	private externalAudio: undefined | HTMLAudioElement;

	getSsmlStripped(): string {
		return this.content.replace(/<[^>]*>/g, '');
	}

	async load() {
		if (this.abortController.signal.aborted) return;

		return new Promise<void>(async (resolve, reject) => {
			// Handle cancellation
			this.abortController.signal.addEventListener('abort', () => {
				// todo clean up
				reject(new Error('Loading cancelled'));
			});

			const currentConfig = get(config);
			const currentSettings = get(settings);

			const audioEngine = currentConfig?.audio.tts.engine;
			if (audioEngine === '') {
				// WebAPI
				this.engine = 'webAPI';

				const voices = speechSynthesis.getVoices();

				const voice =
					voices
						?.filter(
							(v) =>
								v.voiceURI ===
								(currentSettings?.audio?.tts?.voice ?? currentConfig?.audio?.tts?.voice)
						)
						?.at(0) ?? undefined;

				console.log(voice);

				// Browser does not support SSML so use stripped
				this.webApiSpeak = new SpeechSynthesisUtterance(this.getSsmlStripped());
				this.webApiSpeak.rate = currentSettings.audio?.tts?.playbackRate ?? 1;

				if (voice) {
					this.webApiSpeak.voice = voice;
				}

				console.log(this.webApiSpeak);

				resolve();
			} else if (audioEngine === 'browser-kokoro') {
				// Kokoro
				this.engine = 'browser-kokoro';

				this.kokoroMessageContentParts = getMessageContentParts(
					this.getSsmlStripped(), // Kokoro does not support SSML so use stripped
					currentConfig?.audio?.tts?.split_on ?? 'punctuation'
				);

				if (!this.kokoroMessageContentParts.length) {
					console.log('No content to speak');
					toast.info($i18n.t('No content to speak'));

					reject();
				}

				console.debug('Prepared message content for TTS', this.kokoroMessageContentParts);

				const currentTTSWorker = get(TTSWorker);
				if (currentTTSWorker) {
					await TTSWorker.set(
						new KokoroWorker({
							dtype: currentSettings?.audio?.tts?.engineConfig?.dtype ?? 'fp32'
						})
					);

					await get(TTSWorker)?.init?.();
				}
			} else {
				// External (OpenAI, Azure, etc - call backend)

				this.engine = 'external';

				const res = await synthesizeOpenAISpeech(
					localStorage.token,
					currentSettings?.audio?.tts?.defaultVoice === currentConfig?.audio.tts.voice
						? (currentSettings?.audio?.tts?.voice ?? currentConfig?.audio?.tts?.voice)
						: currentConfig?.audio?.tts?.voice,
					this.content,
					undefined,
					this.ssml
				).catch((error) => {
					console.error(error);
					toast.error(`${error}`);

					reject();
				});

				if (res) {
					const blob = await res.blob();
					const blobUrl = URL.createObjectURL(blob);
					const audio = new Audio(blobUrl);
					audio.playbackRate = currentSettings.audio?.tts?.playbackRate ?? 1;

					this.externalAudio = audio;
				}

				resolve();
			}
		});
	}

	async play() {
		if (this.abortController.signal.aborted) return;

		return new Promise<void>(async (resolve, reject) => {
			// Handle cancellation
			this.abortController.signal.addEventListener('abort', () => {
				if (this.engine === 'webAPI') {
					speechSynthesis.cancel();
				} else if (this.engine === 'browser-kokoro') {
					this.kokoroPlayingAudio!.pause();
					this.kokoroPlayingAudio!.currentTime = 0;
				} else if (this.engine === 'external') {
					this.externalAudio!.pause();
					this.externalAudio!.currentTime = 0;
				}

				reject(new Error('Playback cancelled'));
			});

			if (this.engine === 'webAPI') {
				this.webApiSpeak!.onend = () => {
					resolve();
				};

				speechSynthesis.speak(this.webApiSpeak!);
			} else if (this.engine === 'browser-kokoro') {
				const audioParts: Record<number, HTMLAudioElement | null> =
					this.kokoroMessageContentParts.reduce(
						(acc, _sentence, idx) => {
							acc[idx] = null;
							return acc;
						},
						{} as typeof audioParts
					);

				let playing = false;
				let playingIdx = 0;

				async function playPart() {
					if (!playing) {
						const audio = audioParts[playingIdx];

						if (!audio) {
							playing = false;
							return;
						}

						playing = true;
						audio.onended = () => {
							playingIdx++;
							playing = false;

							if (playingIdx >= Object.keys(audioParts).length) {
								resolve();
								return;
							}

							playPart();
						};

						audio.play();
					}
				}

				const currentTTSWorker = get(TTSWorker);
				for (const [idx, sentence] of this.kokoroMessageContentParts.entries()) {
					const blob = await currentTTSWorker
						.generate({
							text: sentence,
							voice: get(settings)?.audio?.tts?.voice ?? get(config)?.audio?.tts?.voice
						})
						.catch((error) => {
							console.error(error);
							toast.error(`${error}`);

							reject();
						});

					if (blob) {
						const audio = new Audio(blob);
						audio.playbackRate = get(settings)?.audio?.tts?.playbackRate ?? 1;

						this.kokoroAudioParts[idx] = audio;
						playPart();
					}
				}
			} else if (this.engine === 'external') {
				this.externalAudio!.onended = () => {
					resolve();
				};

				this.externalAudio!.play();
			}
		});
	}

	cancel() {
		this.abortController.abort();
		if (this.onCancel) this.onCancel();
	}

	isCanceled() {
		return this.abortController.signal.aborted;
	}

	_renewAbortController() {
		this.abortController = new AbortController();
	}

	// Callbacks
	onLoading?: () => void;
	onSpeaking?: () => void;
	onFinish?: () => void;
	onCancel?: () => void;

	constructor(content: string, ssml?: boolean) {
		this._id = uuidv4();
		this.content = content;
		this.ssml = ssml ?? false;
		this.abortController = new AbortController();
	}
}

export class TTSManager {
	private static ttsQueue: TTSElement[] = [];

	static queue(element: TTSElement) {
		element._renewAbortController();
		this.ttsQueue.push(element);

		// If this is the only element then play in now
		if (this.ttsQueue.length === 1) {
			this.play();
		}
	}

	static cancel(element: TTSElement) {
		const idx = this.ttsQueue.findIndex((e) => e._id === element._id);

		if (idx !== -1) {
			this.ttsQueue[idx].cancel();
			this.ttsQueue.splice(idx, 1);
		}
	}

	private static async play() {
		if (this.ttsQueue.length >= 1) {
			const e = this.ttsQueue[0];

			try {
				if (e.onLoading) e.onLoading();
				await e.load();

				if (e.onSpeaking) e.onSpeaking();
				await e.play();

				if (e.onFinish) e.onFinish();

				// Remove once playback completed
				this.ttsQueue.splice(0, 1);
			} catch {
				// Audio playback was cancelled - this would have already removed it
			} finally {
				// Play the next in the queue
				this.play();
			}
		}
	}

	static cancelAll() {
		while (this.ttsQueue.length > 0) {
			const element = this.ttsQueue.pop()!;
			element.cancel();
		}
	}
}
