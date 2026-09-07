#!/usr/bin/env node

import { Command, Option } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { parseScreenshot, parseMultipleScreenshots, deduplicateClimbs } from './parser';
import type { MoonBoardClimb } from './types';
import { boardRows, type HoldSetup } from './board-profiles';

const setupOption = () =>
  new Option('--holdsetup <id>', 'Upstream MoonBoard setup ID (not Boardsesh layout ID)')
    .argParser((value) => {
      const id = Number(value) as HoldSetup;
      boardRows(id);
      return id;
    })
    .default(21);
const profileOption = () =>
  new Option('--screenshot-profile <profile>', 'Validated screenshot layout')
    .choices(['legacy-ios', 'android-pixel8pro-1.3.68'])
    .default('legacy-ios');

/**
 * Check if a file is an image based on extension
 */
function isImageFile(filePath: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'];
  const ext = path.extname(filePath).toLowerCase();
  return imageExtensions.includes(ext);
}

const program = new Command();

program.name('moonboard-ocr').description('Extract MoonBoard climb data from screenshots using OCR').version('0.1.0');

// Parse command - main entry point
program
  .command('parse <input>')
  .description('Parse MoonBoard screenshot(s) and extract climb data')
  .option('-o, --output <file>', 'Output JSON file', 'climbs.json')
  .option('--no-dedupe', 'Skip deduplication of climbs')
  .addOption(setupOption())
  .addOption(profileOption())
  .action(async (input: string, options) => {
    try {
      const inputPath = path.resolve(input);
      const stat = await fs.stat(inputPath);
      let imagePaths: string[] = [];

      console.info(`Processing: ${input}`);

      if (stat.isDirectory()) {
        // Process all images in directory
        const files = await fs.readdir(inputPath);
        imagePaths = files
          .filter((f) => isImageFile(f))
          .map((f) => path.join(inputPath, f))
          .sort();
        console.info(`Found ${imagePaths.length} image files`);
      } else if (isImageFile(inputPath)) {
        // Single image
        imagePaths = [inputPath];
      } else {
        console.error('Input must be an image or directory of images');
        process.exit(1);
      }

      if (imagePaths.length === 0) {
        console.error('No images found to process');
        process.exit(1);
      }

      // Parse all images
      console.info('Parsing screenshots...');
      const { climbs, errors } = await parseMultipleScreenshots(
        imagePaths,
        (current, total, file) => {
          process.stdout.write(`\rProcessing: ${current}/${total} - ${file}`);
        },
        { holdsetup: options.holdsetup, screenshotProfile: options.screenshotProfile },
      );
      console.info(''); // New line after progress

      // Report errors
      if (errors.length > 0) {
        console.info(`\nWarnings (${errors.length} files had errors):`);
        for (const err of errors.slice(0, 10)) {
          console.info(`  - ${err.file}: ${err.error}`);
        }
        if (errors.length > 10) {
          console.info(`  ... and ${errors.length - 10} more`);
        }
      }

      // Deduplicate if requested
      let finalClimbs = climbs;
      if (options.dedupe !== false && climbs.length > 1) {
        finalClimbs = deduplicateClimbs(climbs);
        console.info(`\nDeduplicated: ${climbs.length} -> ${finalClimbs.length} unique climbs`);
      }

      // Write output
      const outputPath = path.resolve(options.output);
      await fs.writeFile(outputPath, JSON.stringify(finalClimbs, null, 2));
      console.info(`\nOutput written to: ${outputPath}`);
      console.info(`Total climbs extracted: ${finalClimbs.length}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Dedupe command - remove duplicate climbs from JSON
program
  .command('dedupe <input>')
  .description('Remove duplicate climbs from a JSON file')
  .option('-o, --output <file>', 'Output JSON file')
  .action(async (input: string, options) => {
    try {
      const inputPath = path.resolve(input);
      const content = await fs.readFile(inputPath, 'utf-8');
      const climbs: MoonBoardClimb[] = JSON.parse(content);

      console.info(`Loaded ${climbs.length} climbs from ${input}`);

      const dedupedClimbs = deduplicateClimbs(climbs);
      console.info(`Deduplicated to ${dedupedClimbs.length} unique climbs`);

      const outputPath = options.output ? path.resolve(options.output) : inputPath;
      await fs.writeFile(outputPath, JSON.stringify(dedupedClimbs, null, 2));
      console.info(`Output written to: ${outputPath}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Single image test command - useful for debugging
program
  .command('test <image>')
  .description('Test parsing a single image and show detailed output')
  .addOption(setupOption())
  .addOption(profileOption())
  .action(async (image: string, options) => {
    try {
      const imagePath = path.resolve(image);
      console.info(`Testing: ${imagePath}\n`);

      const result = await parseScreenshot(imagePath, {
        holdsetup: options.holdsetup,
        screenshotProfile: options.screenshotProfile,
      });

      if (result.success && result.climb) {
        console.info('=== Parsed Climb Data ===');
        console.info(`Name: ${result.climb.name}${result.climb.isBenchmark ? ' [BENCHMARK]' : ''}`);
        console.info(`Setter: ${result.climb.setter}`);
        console.info(`Angle: ${result.climb.angle}°`);
        console.info(`User Grade: ${result.climb.userGrade}`);
        console.info(`Setter Grade: ${result.climb.setterGrade}`);
        console.info(`Benchmark: ${result.climb.isBenchmark ? 'Yes' : 'No'}`);
        console.info('\n=== Holds ===');
        console.info(`Start: ${result.climb.holds.start.join(', ') || 'None detected'}`);
        console.info(`Hand: ${result.climb.holds.hand.join(', ') || 'None detected'}`);
        console.info(`Finish: ${result.climb.holds.finish.join(', ') || 'None detected'}`);

        if (result.warnings.length > 0) {
          console.info('\n=== Warnings ===');
          for (const warning of result.warnings) {
            console.info(`- ${warning}`);
          }
        }

        console.info('\n=== Raw JSON ===');
        console.info(JSON.stringify(result.climb, null, 2));
      } else {
        console.info('=== Parse Failed ===');
        console.info(`Error: ${result.error}`);
        if (result.warnings.length > 0) {
          console.info('\nWarnings:');
          for (const warning of result.warnings) {
            console.info(`- ${warning}`);
          }
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
