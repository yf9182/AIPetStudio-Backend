import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";

type VideoPayload = { taskID: string };

export class VideoTaskWorkflow extends WorkflowEntrypoint<Env, VideoPayload> {
  async run(event: Readonly<WorkflowEvent<VideoPayload>>, step: WorkflowStep): Promise<void> {
    const taskID = event.payload.taskID;
    await step.do("mark-video-workflow-started", async () => {
      await this.env.DB.prepare("UPDATE tasks SET state = 'processing', progress = 5, updated_at = ? WHERE id = ? AND kind = 'video' AND state = 'queued'")
        .bind(new Date().toISOString(), taskID)
        .run();
    });
  }
}
