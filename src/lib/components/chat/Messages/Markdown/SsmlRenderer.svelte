<script lang="ts">
	import { toast } from 'svelte-sonner';

	import type { i18n as i18nType } from 'i18next';
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';

	const i18n = getContext<Writable<i18nType>>('i18n');

	import { synthesizeOpenAISpeech } from '$lib/apis/audio';
	import { config, settings, TTSWorker } from '$lib/stores';
	import { getMessageContentParts } from '$lib/utils';

	import { KokoroWorker } from '$lib/workers/KokoroWorker';
	import VoiceVisualiser from './VoiceVisualiser.svelte';

	export let content: string;
	const strippedContent = content.replace(/<[^>]*>/g, '');
	const formattedContent = strippedContent
		.replace(/\s*\n\s*|\s+/g, ' ')
		.replace(/\s+([.,!?;:])/g, '$1')
		.replace(/([.,!?;:])(?=\S)/g, '$1 ')
		.trim();

	export let done: boolean;

	let showingTranscript = false;

	let loadingSpeech = false;
	let speaking = false;

	let audioParts: Record<number, HTMLAudioElement | null> = {};
	let speakingIdx: number | undefined;
	let speakingAudio: HTMLAudioElement | undefined;

	const playAudio = (idx: number) => {
		return new Promise<void>((res) => {
			speakingIdx = idx;
			const audio = audioParts[idx];

			if (!audio) {
				return res();
			}

			audio.play();
			audio.onended = async () => {
				await new Promise((r) => setTimeout(r, 300));

				if (Object.keys(audioParts).length - 1 === idx) {
					speaking = false;
				}

				res();
			};
		});
	};

	const toggleSpeakMessage = async () => {
		if (speaking) {
			try {
				speechSynthesis.cancel();

				if (speakingAudio !== undefined) {
					speakingAudio.pause();
					speakingAudio.currentTime = 0;
				}

				if (speakingIdx !== undefined && audioParts[speakingIdx]) {
					audioParts[speakingIdx]!.pause();
					audioParts[speakingIdx]!.currentTime = 0;
				}
			} catch {}

			speaking = false;
			speakingIdx = undefined;
			return;
		}

		if (!(content ?? '').trim().length) {
			toast.info($i18n.t('No content to speak'));
			return;
		}

		speaking = true;

		if ($config.audio.tts.engine === '') {
			let voices = [];
			const getVoicesLoop = setInterval(() => {
				voices = speechSynthesis.getVoices();
				if (voices.length > 0) {
					clearInterval(getVoicesLoop);

					const voice =
						voices
							?.filter(
								(v) => v.voiceURI === ($settings?.audio?.tts?.voice ?? $config?.audio?.tts?.voice)
							)
							?.at(0) ?? undefined;

					console.log(voice);

					// Browser does not support SSML so use stripped
					const speak = new SpeechSynthesisUtterance(strippedContent);
					speak.rate = $settings.audio?.tts?.playbackRate ?? 1;

					console.log(speak);

					speak.onend = () => {
						speaking = false;
					};

					if (voice) {
						speak.voice = voice;
					}

					speechSynthesis.speak(speak);
				}
			}, 100);
		} else {
			loadingSpeech = true;
			let lastPlayedAudioPromise = Promise.resolve(); // Initialize a promise that resolves immediately

			if ($settings.audio?.tts?.engine === 'browser-kokoro') {
				const messageContentParts: string[] = getMessageContentParts(
					strippedContent, // Kokoro does not support SSML so use stripped
					$config?.audio?.tts?.split_on ?? 'punctuation'
				);

				if (!messageContentParts.length) {
					console.log('No content to speak');
					toast.info($i18n.t('No content to speak'));

					speaking = false;
					loadingSpeech = false;
					return;
				}

				console.debug('Prepared message content for TTS', messageContentParts);

				audioParts = messageContentParts.reduce(
					(acc, _sentence, idx) => {
						acc[idx] = null;
						return acc;
					},
					{} as typeof audioParts
				);

				if (!$TTSWorker) {
					await TTSWorker.set(
						new KokoroWorker({
							dtype: $settings.audio?.tts?.engineConfig?.dtype ?? 'fp32'
						})
					);

					await $TTSWorker.init();
				}

				for (const [idx, sentence] of messageContentParts.entries()) {
					const blob = await $TTSWorker
						.generate({
							text: sentence,
							voice: $settings?.audio?.tts?.voice ?? $config?.audio?.tts?.voice
						})
						.catch((error) => {
							console.error(error);
							toast.error(`${error}`);

							speaking = false;
							loadingSpeech = false;
						});

					if (blob) {
						const audio = new Audio(blob);
						audio.playbackRate = $settings.audio?.tts?.playbackRate ?? 1;

						audioParts[idx] = audio;
						loadingSpeech = false;
						lastPlayedAudioPromise = lastPlayedAudioPromise.then(() => playAudio(idx));
					}
				}
			} else {
				const res = await synthesizeOpenAISpeech(
					localStorage.token,
					$settings?.audio?.tts?.defaultVoice === $config.audio.tts.voice
						? ($settings?.audio?.tts?.voice ?? $config?.audio?.tts?.voice)
						: $config?.audio?.tts?.voice,
					content,
					undefined,
					true
				).catch((error) => {
					console.error(error);
					toast.error(`${error}`);

					speaking = false;
					loadingSpeech = false;
				});

				if (res) {
					const blob = await res.blob();
					const blobUrl = URL.createObjectURL(blob);
					const audio = new Audio(blobUrl);
					audio.playbackRate = $settings.audio?.tts?.playbackRate ?? 1;

					speakingAudio = audio;
					loadingSpeech = false;

					speakingAudio.play();
					speakingAudio.onended = () => {
						speaking = false;
					};
				}
			}
		}
	};

	if (($settings?.audio?.ssml?.autoplay ?? false) && !done) {
		toggleSpeakMessage();
	}
</script>

{#if $settings?.audio?.ssml?.show ?? true}
	<div class="rounded-xl bg-gray-50 dark:bg-gray-850 w-fit my-1 p-2 flex flex-col">
		<button
			class="visible p-1.5 w-fit hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
			aria-label={$i18n.t('Read Aloud')}
			on:click={() => {
				if (!loadingSpeech) {
					toggleSpeakMessage();
				}
			}}
		>
			<div class="flex flex-row items-center gap-1.5">
				{#if loadingSpeech}
					<svg
						class=" w-4 h-4"
						fill="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
						xmlns="http://www.w3.org/2000/svg"
					>
						<style>
							.spinner_S1WN {
								animation: spinner_MGfb 0.8s linear infinite;
								animation-delay: -0.8s;
							}

							.spinner_Km9P {
								animation-delay: -0.65s;
							}

							.spinner_JApP {
								animation-delay: -0.5s;
							}

							@keyframes spinner_MGfb {
								93.75%,
								100% {
									opacity: 0.2;
								}
							}
						</style>
						<circle class="spinner_S1WN" cx="4" cy="12" r="3" />
						<circle class="spinner_S1WN spinner_Km9P" cx="12" cy="12" r="3" />
						<circle class="spinner_S1WN spinner_JApP" cx="20" cy="12" r="3" />
					</svg>
				{:else if speaking}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						aria-hidden="true"
						stroke-width="2.3"
						stroke="currentColor"
						class="w-4 h-4"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
						/>
					</svg>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						aria-hidden="true"
						stroke-width="2.3"
						stroke="currentColor"
						class="w-4 h-4"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
						/>
					</svg>
				{/if}

				<VoiceVisualiser className="w-40 h-8" animating={!loadingSpeech && speaking} />
			</div>
		</button>

		<button
			type="button"
			class="w-fit no-underline text-xs hover:underline cursor-pointer text-gray-400"
			on:click={() => {
				showingTranscript = !showingTranscript;
			}}
			aria-label={$i18n.t(showingTranscript ? 'Hide Transcript' : 'Show Transcript')}
		>
			{showingTranscript ? 'Hide transcript' : 'Show transcript'}
		</button>
		{#if showingTranscript}
			<div class="text-sm text-gray-300 break-words p-1 max-w-96">{formattedContent}</div>
		{/if}
	</div>
{/if}
