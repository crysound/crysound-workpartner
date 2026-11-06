/** Collect measurable issues in the current browser document.
 * @returns {object} Overflow, broken images, small text and document title. */
export function inspectDocument() {
  const visible = [...document.querySelectorAll('body *')].filter(element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width && box.height && style.visibility !== 'hidden' && style.display !== 'none';
  });
  return {
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).map(image => image.getAttribute('src')),
    smallText: visible.filter(element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()) && parseFloat(getComputedStyle(element).fontSize) < 12).map(element => element.textContent.trim().slice(0, 80)),
    title: document.title,
  };
}

/**
 * Load deferred images before taking a final health reading.
 * @returns {Promise<void>} Settles when fonts and current image decodes finish; failed images remain inspectable.
 */
export async function prepareDocument() {
  await document.fonts.ready;
  await Promise.allSettled([...document.images].map(image => {
    image.loading = 'eager';
    return image.decode();
  }));
}
