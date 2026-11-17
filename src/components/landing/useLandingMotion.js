import { useEffect } from 'react';

// Scroll enhancements for the landing page. The page is complete without any of this: the server-rendered
// markup shows every section and every product screen in its finished state. This hook only arms motion
// after the page has loaded in a browser, and it does nothing when the visitor asks for reduced motion.
//
//   [data-reveal]  Sections below the fold fade up once as they enter the screen.
//   [data-live]    Product screens get "is-live" while on screen, which starts their small animations.
//   [data-steps]   Setup steps light up as the visitor scrolls past them. This is color only, so it also
//                  runs with reduced motion.

/** @param {{current: HTMLElement | null}} rootRef */
export function useLandingMotion(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const undo = [];
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const list = root.querySelector('[data-steps]');
    if (list) {
      const steps = Array.from(list.querySelectorAll('[data-step]'));
      let frame = 0;
      const update = () => {
        frame = 0;
        const line = window.innerHeight * 0.62;
        let reached = -1;
        steps.forEach((step, index) => { if (step.getBoundingClientRect().top < line) reached = index; });
        steps.forEach((step, index) => {
          step.classList.toggle('is-reached', index <= reached);
          step.classList.toggle('is-current', index === reached);
        });
      };
      const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
      list.classList.add('setup-steps--armed');
      update();
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      undo.push(() => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        list.classList.remove('setup-steps--armed');
        steps.forEach((step) => step.classList.remove('is-reached', 'is-current'));
      });
    }

    if (!calm && 'IntersectionObserver' in window) {
      document.documentElement.classList.add('landing-motion');
      undo.push(() => document.documentElement.classList.remove('landing-motion'));

      const live = new IntersectionObserver((entries) => {
        entries.forEach((entry) => entry.target.classList.toggle('is-live', entry.isIntersecting));
      }, { threshold: 0.3 });
      root.querySelectorAll('[data-live]').forEach((element) => live.observe(element));
      undo.push(() => { live.disconnect(); root.querySelectorAll('[data-live]').forEach((element) => element.classList.remove('is-live')); });

      // Only what sits below the first screen is hidden, so nothing visible on load ever blinks out.
      const reveal = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          reveal.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
      const armed = Array.from(root.querySelectorAll('[data-reveal]')).filter((element) => element.getBoundingClientRect().top > window.innerHeight * 0.92);
      armed.forEach((element) => { element.classList.add('reveal-armed'); reveal.observe(element); });
      undo.push(() => { reveal.disconnect(); armed.forEach((element) => element.classList.remove('reveal-armed', 'is-in')); });
    }

    return () => undo.forEach((run) => run());
  }, [rootRef]);
}
