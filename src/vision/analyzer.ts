/**
 * VisionAnalyzer — interface for visual media description engines.
 *
 * Implementations call an actual vision model (e.g. Ollama with llama3.2-vision).
 * FakeVisionAnalyzer is provided for use in tests and as a placeholder until a
 * real implementation is wired in a later task.
 */

export interface VisionAnalyzer {
  /**
   * Produce a natural-language description of the image at the given path.
   * Returns the description text and the engine identifier (model label).
   * Throws on unrecoverable failure (caller writes a 'failed' row).
   */
  describeImage(imagePath: string): Promise<{ description: string; engine: string }>;

  /**
   * Produce a single natural-language description from a SEQUENCE of images
   * (e.g. frames sampled from a video, in temporal order). The model sees all
   * frames together and is asked to describe what happens across them.
   * With a single path this is equivalent to describeImage.
   * Throws on unrecoverable failure (caller writes a 'failed' row).
   */
  describeImages(imagePaths: string[]): Promise<{ description: string; engine: string }>;
}

/**
 * Fake implementation for testing.
 *
 * By default returns a fixed description. Configure `returnValue` to override
 * the resolved value, or set `shouldThrow` / `throwWith` to simulate failure.
 */
export class FakeVisionAnalyzer implements VisionAnalyzer {
  returnValue: { description: string; engine: string } = {
    description: "a test image",
    engine: "fake-vision",
  };

  shouldThrow = false;
  throwWith: Error = new Error("FakeVisionAnalyzer: simulated failure");

  /** Records the most recent call's paths so tests can assert on frame counts. */
  lastImagePaths: string[] = [];

  async describeImage(imagePath: string): Promise<{ description: string; engine: string }> {
    return this.describeImages([imagePath]);
  }

  async describeImages(imagePaths: string[]): Promise<{ description: string; engine: string }> {
    this.lastImagePaths = imagePaths;
    if (this.shouldThrow) {
      throw this.throwWith;
    }
    return this.returnValue;
  }
}
