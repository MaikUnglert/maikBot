import { config } from '../config.js';
import { logger } from '../logger.js';
import { taskSchedulerService } from './task-scheduler.service.js';
import { geminiCliService } from './gemini-cli.service.js';
import { assistant } from '../core/assistant.js';
import { llmService } from './llm.service.js';
import { sendToSession } from './channel-sender.service.js';
import { registerHeartbeatWakeCallback } from './heartbeat-wake.js';
import type { LlmMessage } from './llm.types.js';

const GEMINI_CLI_REVIEW_PROMPT = `You are MaikBot. A Gemini CLI job just finished. Review the result and write a short message for the user in Telegram format.

Format your reply as:
**Summary:** [1-2 sentences on what was done]
**Changes:** [files modified, lines added/removed if available]
**Review:** [Your assessment: looks good / issues found / suggestions]

Keep it concise (under 300 words). Use **bold** for section headers.`;

async function runGeminiCliReview(
  job: Awaited<ReturnType<typeof geminiCliService.getJob>>
): Promise<string> {
  if (!job || !job.result) return 'No result to review.';

  const { userRequest, recentMessages } = job.contextSnapshot;
  const result = job.result;
  const responseText = result.response ?? '';
  const errorText = result.error?.message ?? '';
  const stats = result.stats as { files?: { totalLinesAdded?: number; totalLinesRemoved?: number }; tools?: { totalCalls?: number } } | undefined;
  const files = stats?.files;
  const linesAdded = files?.totalLinesAdded ?? '?';
  const linesRemoved = files?.totalLinesRemoved ?? '?';

  const contextBlock = recentMessages.length > 0
    ? `Conversation context:\n${recentMessages.map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`).join('\n')}`
    : '';

  const resultBlock =
    job.status === 'failed'
      ? `Gemini CLI failed. Error: ${errorText}`
      : `Gemini CLI output:\n${responseText.slice(0, 6000)}`;

  const messages: LlmMessage[] = [
    { role: 'system', content: GEMINI_CLI_REVIEW_PROMPT },
    {
      role: 'user',
      content: `User request: ${userRequest}

${contextBlock}

${resultBlock}

Stats: +${linesAdded}/-${linesRemoved} lines.`,
    },
  ];

  const chatResult = await llmService.chat(messages, []);
  return (chatResult.content ?? 'Review completed.').trim();
}

/**
 * Compute next heartbeat delay in ms.
 * Returns null when nothing is scheduled (tasks, Gemini jobs) – heartbeat will sleep until woken.
 */
async function getNextDelayMs(hadWorkThisTick: boolean): Promise<number | null> {
  const activeSec = config.heartbeatActiveIntervalSec;
  const idleSec = config.heartbeatIdleIntervalSec;
  const activeMs = activeSec * 1000;
  const idleMs = idleSec * 1000;

  if (hadWorkThisTick) {
    return activeMs; // something ran, check again soon
  }

  const [msUntilNextTask, hasRunningJobs, completedCount] = await Promise.all([
    taskSchedulerService.getMsUntilNextDue(),
    geminiCliService.hasRunningJobs(),
    geminiCliService.getCompletedJobsForReview().then((j) => j.length),
  ]);

  if (completedCount > 0) return 1000; // completed jobs we missed (race), run soon
  if (hasRunningJobs) return activeMs; // Gemini CLI running, poll frequently
  if (msUntilNextTask === 0) return activeMs; // task due, will catch next tick
  if (msUntilNextTask < Infinity) {
    if (msUntilNextTask <= 2 * 60 * 1000) return activeMs; // due within 2 min
    const wakeBeforeDue = 60 * 1000; // wake 1 min before
    return Math.min(Math.max(msUntilNextTask - wakeBeforeDue, activeMs), idleMs);
  }

  return null; // nothing scheduled: sleep until woken (task added or Gemini job started)
}

/**
 * Start the heartbeat loop. Checks for:
 * - Due scheduled tasks (reminders, daily, weekly jobs)
 * - Completed Gemini CLI jobs (review and notify)
 * Only runs when work is pending (tasks or Gemini jobs). Sleeps when idle until woken
 * by a new task or Gemini job.
 */
export function startHeartbeat(): void {
  const runTick = async (): Promise<boolean> => {
    try {
      let hadWork = false;

      const due = await taskSchedulerService.getAndProcessDueTasks();
      for (const task of due) {
        hadWork = true;
        logger.info(
          { taskId: task.id, sessionId: task.sessionId, message: task.message.slice(0, 80) },
          'Heartbeat: processing due task'
        );
        try {
          const response = await assistant.handleTextWithTrace(
            task.sessionId,
            task.message,
            {}
          );
          await sendToSession(task.sessionId, response.reply);
        } catch (err) {
          logger.error(
            { err, taskId: task.id, sessionId: task.sessionId },
            'Heartbeat: failed to process task'
          );
          await sendToSession(
            task.sessionId,
            'A scheduled task failed. Please try again or check the logs.'
          );
        }
      }

      const completedJobs = await geminiCliService.getCompletedJobsForReview();
      for (const job of completedJobs) {
        hadWork = true;
        logger.info(
          { jobId: job.id, sessionId: job.sessionId, status: job.status },
          'Heartbeat: reviewing Gemini CLI job'
        );
        try {
          const review = await runGeminiCliReview(job);
          const header =
            job.status === 'completed'
              ? '**Gemini CLI finished.**\n\n'
              : '**Gemini CLI failed.**\n\n';
          await sendToSession(job.sessionId, header + review);
          await geminiCliService.markJobReviewed(job.id);
        } catch (err) {
          logger.error({ err, jobId: job.id, sessionId: job.sessionId }, 'Heartbeat: Gemini CLI review failed');
          await sendToSession(
            job.sessionId,
            `Gemini CLI job finished but the review failed. Check logs. Status: ${job.status}.`
          );
          await geminiCliService.markJobReviewed(job.id);
        }
      }

      return hadWork;
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick failed');
      return false;
    }
  };

  const scheduleNextOrSleep = (hadWork: boolean): void => {
    void getNextDelayMs(hadWork).then((delayMs) => {
      if (delayMs === null) {
        logger.debug('Heartbeat: nothing scheduled, sleeping until woken');
        return;
      }
      setTimeout(() => {
        void runTick().then(scheduleNextOrSleep);
      }, delayMs);
    });
  };

  registerHeartbeatWakeCallback(() => {
    void runTick().then(scheduleNextOrSleep);
  });

  void runTick().then(scheduleNextOrSleep);
  logger.info(
    {
      activeSec: config.heartbeatActiveIntervalSec,
      idleSec: config.heartbeatIdleIntervalSec,
    },
    'Heartbeat started (runs only when tasks or Gemini CLI jobs are scheduled)'
  );
}
