import { useEffect, useRef } from 'react';
import { setAudioModeAsync, useAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import countdownSound from '../../assets/sounds/countdown.wav';
import goSound from '../../assets/sounds/go.wav';

const COUNTDOWN_SECONDS = 3;

function replay(player: AudioPlayer) {
  void player.seekTo(0);
  player.play();
}

type WorkoutCuesInput = {
  /** Whole seconds left on the running countdown, or null when nothing is counting down. */
  secondsLeft: number | null;
  /** Changes whenever the runner moves to another rest or climb. */
  phaseKey: string;
  isClimbing: boolean;
};

/**
 * Sound and haptics for the workout clock, so the climber can leave the phone
 * on the floor: a tick for each of the last three seconds of a rest or
 * interval, and a higher tone when it's time to climb. Plays in silent mode and
 * over music.
 */
export function useWorkoutCues({ secondsLeft, phaseKey, isClimbing }: WorkoutCuesInput) {
  const countdownPlayer = useAudioPlayer(countdownSound);
  const goPlayer = useAudioPlayer(goSound);
  const lastCountdownRef = useRef<string | null>(null);
  const previousPhaseRef = useRef<string | null>(null);

  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(() => {});
  }, []);

  useEffect(() => {
    if (secondsLeft === null || secondsLeft < 1 || secondsLeft > COUNTDOWN_SECONDS) return;
    const key = `${phaseKey}:${secondsLeft}`;
    if (lastCountdownRef.current === key) return;
    lastCountdownRef.current = key;
    replay(countdownPlayer);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [secondsLeft, phaseKey, countdownPlayer]);

  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = phaseKey;
    // No tone for the workout's very first climb: the climber just pressed Start.
    if (previous === null || previous === phaseKey || !isClimbing) return;
    replay(goPlayer);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [phaseKey, isClimbing, goPlayer]);
}
