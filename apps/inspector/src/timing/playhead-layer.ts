import { motionSegments, type PlayheadMotion } from "./display";

const translate = (x: number) => `translateX(${x}px)`;

/**
 * The playhead on its own compositor layer: an absolutely positioned element moved only by
 * `transform`. Standing still, it holds a transform. While playing, it runs the motion's straight
 * pieces as Web Animations whose start times are page times, so the compositor samples the
 * position at each frame's own time, with no work on the main thread, and the playhead keeps
 * moving while the main thread is busy (a redraw of the stage, a mark list update, garbage
 * collection). `x` maps a source time to the element's left edge in CSS pixels.
 */
export class PlayheadLayer {
  private animations: Animation[] = [];

  constructor(private readonly element: HTMLElement) {}

  hold(x: number) {
    this.cancel();
    this.element.style.transform = translate(x);
  }

  run(motion: PlayheadMotion, x: (timeMs: number) => number) {
    this.cancel();
    this.element.style.transform = translate(x(motion.holdMs));
    for (const segment of motionSegments(motion)) {
      const animation = this.element.animate(
        [{ transform: translate(x(segment.fromMs)) }, { transform: translate(x(segment.toMs)) }],
        {
          duration: segment.durationMs,
          iterations: segment.iterations,
          easing: "linear",
          fill: segment.holdEnd ? "forwards" : "none",
        },
      );
      animation.startTime = segment.startPerfMs;
      this.animations.push(animation);
    }
  }

  cancel() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }
}
