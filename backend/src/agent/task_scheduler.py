import datetime
import uuid
import heapq

class TaskScheduler:
    """
    Schedules and manages delayed and recurring tasks.
    Tasks are stored in a min-heap ordered by their next_run_time.
    """
    def __init__(self):
        # Min-heap to store tasks, ordered by next_run_time
        # Each item in the heap is (next_run_time, task_id, task_data)
        self._task_heap = []
        # Dictionary to store task details by task_id for quick access/modification
        self._tasks = {}

    def _generate_task_id(self):
        return str(uuid.uuid4())

    def _schedule_task(self, task_id, next_run_time, callback, args, kwargs, interval_seconds=None):
        """Internal method to schedule or reschedule a task."""
        task_data = {
            "id": task_id,
            "next_run_time": next_run_time,
            "callback": callback,
            "args": args,
            "kwargs": kwargs,
            "interval_seconds": interval_seconds, # None for one-time tasks
        }
        self._tasks[task_id] = task_data
        heapq.heappush(self._task_heap, (next_run_time, task_id, task_data))
        return task_id

    def add_task_at_time(self, run_time: datetime.datetime, callback, *args, **kwargs):
        """
        Schedules a one-time task to run at a specific datetime.

        Args:
            run_time (datetime.datetime): The exact UTC time when the task should run.
            callback (callable): The function to call when the task runs.
            *args: Positional arguments for the callback.
            **kwargs: Keyword arguments for the callback.

        Returns:
            str: The ID of the scheduled task.
        """
        if run_time.tzinfo is None:
            raise ValueError("run_time must be timezone-aware (UTC recommended).")
        task_id = self._generate_task_id()
        print(f"Scheduling one-time task '{callback.__name__}' at {run_time} (ID: {task_id})")
        return self._schedule_task(task_id, run_time, callback, args, kwargs)

    def add_task_in_seconds(self, delay_seconds: int, callback, *args, **kwargs):
        """
        Schedules a one-time task to run after a specified delay.

        Args:
            delay_seconds (int): The delay in seconds before the task runs.
            callback (callable): The function to call when the task runs.
            *args: Positional arguments for the callback.
            **kwargs: Keyword arguments for the callback.

        Returns:
            str: The ID of the scheduled task.
        """
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        run_time = now_utc + datetime.timedelta(seconds=delay_seconds)
        task_id = self._generate_task_id()
        print(f"Scheduling one-time task '{callback.__name__}' in {delay_seconds}s at {run_time} (ID: {task_id})")
        return self._schedule_task(task_id, run_time, callback, args, kwargs)

    def add_recurring_task(self, interval_seconds: int, callback, *args, **kwargs):
        """
        Schedules a task to run repeatedly at a given interval.
        The first run will be after the interval from now.

        Args:
            interval_seconds (int): The interval in seconds between task runs.
            callback (callable): The function to call when the task runs.
            *args: Positional arguments for the callback.
            **kwargs: Keyword arguments for the callback.

        Returns:
            str: The ID of the scheduled task.
        """
        if interval_seconds <= 0:
            raise ValueError("Interval must be a positive number of seconds.")
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        first_run_time = now_utc + datetime.timedelta(seconds=interval_seconds)
        task_id = self._generate_task_id()
        print(f"Scheduling recurring task '{callback.__name__}' every {interval_seconds}s (first run at {first_run_time}) (ID: {task_id})")
        return self._schedule_task(task_id, first_run_time, callback, args, kwargs, interval_seconds)

    def cancel_task(self, task_id: str):
        """
        Cancels a scheduled task.

        Args:
            task_id (str): The ID of the task to cancel.

        Returns:
            bool: True if the task was found and cancelled, False otherwise.
        """
        if task_id in self._tasks:
            print(f"Cancelling task {task_id}")
            # Mark for removal. Actual removal from heap happens during get_due_tasks
            self._tasks[task_id]['cancelled'] = True
            return True
        return False

    def get_due_tasks(self, current_time: datetime.datetime):
        """
        Retrieves all tasks that are due to run at or before the current_time.
        Reschedules recurring tasks.

        Args:
            current_time (datetime.datetime): The current UTC time.

        Returns:
            list: A list of (callback, args, kwargs) for tasks that are due.
        """
        due_tasks = []
        new_heap = []

        while self._task_heap and self._task_heap[0][0] <= current_time:
            next_run_time, task_id, task_data = heapq.heappop(self._task_heap)

            # Check if task was cancelled
            if task_data.get('cancelled'):
                del self._tasks[task_id]
                continue

            due_tasks.append((task_data['callback'], task_data['args'], task_data['kwargs']))

            if task_data['interval_seconds'] is not None:
                # Reschedule recurring task
                next_run_time = current_time + datetime.timedelta(seconds=task_data['interval_seconds'])
                task_data['next_run_time'] = next_run_time
                heapq.heappush(new_heap, (next_run_time, task_id, task_data))
                print(f"Rescheduling recurring task '{task_data['callback'].__name__}' (ID: {task_id}) for {next_run_time}")
            else:
                # One-time task, remove it
                del self._tasks[task_id]

        # Merge remaining tasks from original heap and newly scheduled recurring tasks
        # This is more efficient than re-pushing everything if the original heap is large
        self._task_heap = sorted(self._task_heap + new_heap)
        heapq.heapify(self._task_heap) # Ensure it's a valid heap after merge

        return due_tasks

    @property
    def has_pending_tasks(self):
        """Returns True if there are any non-cancelled tasks remaining."""
        # Clean up cancelled tasks before checking
        temp_heap = []
        for next_run_time, task_id, task_data in self._task_heap:
            if not task_data.get('cancelled'):
                heapq.heappush(temp_heap, (next_run_time, task_id, task_data))
            else:
                del self._tasks[task_id]
        self._task_heap = temp_heap
        return bool(self._task_heap)

    def get_next_task_time(self) -> datetime.datetime | None:
        """Returns the run time of the soonest pending task, or None if no tasks."""
        # Ensure cancelled tasks don't block the next run time
        while self._task_heap and self._tasks[self._task_heap[0][1]].get('cancelled'):
            heapq.heappop(self._task_heap)
        
        if self._task_heap:
            return self._task_heap[0][0]
        return None

if __name__ == '__main__':
    scheduler = TaskScheduler()
    
    # Example callbacks
    def say_hello(name="World"):
        print(f"[{datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S UTC')}] Hello, {name}!")

    def reminder(message):
        print(f"[{datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S UTC')}] REMINDER: {message}")

    def weekly_report():
        print(f"[{datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S UTC')}] Weekly Report Generated!")

    # Schedule tasks
    scheduler.add_task_in_seconds(2, say_hello, "Alice")
    scheduler.add_task_in_seconds(5, reminder, "Take a break!")
    recurring_task_id = scheduler.add_recurring_task(10, weekly_report) # Every 10 seconds

    # Schedule a task at a specific UTC time
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    future_time = now_utc + datetime.timedelta(seconds=7)
    scheduler.add_task_at_time(future_time, say_hello, "Bob")

    print("Scheduler initialized. Running for 35 seconds...")
    current_time_sim = now_utc
    for _ in range(35):
        current_time_sim += datetime.timedelta(seconds=1) # Simulate time passing
        
        due = scheduler.get_due_tasks(current_time_sim)
        for callback, args, kwargs in due:
            callback(*args, **kwargs)
        
        # Simulate agent work
        if not due:
            print(f"[{current_time_sim.strftime('%H:%M:%S UTC')}] No tasks due. Agent working...")

        if _ == 20:
            print(f"[{current_time_sim.strftime('%H:%M:%S UTC')}] Cancelling recurring task: {recurring_task_id}")
            scheduler.cancel_task(recurring_task_id)

        import time
        time.sleep(0.1) # Small sleep to simulate processing, not actual 1 second per iteration
    
    print("Scheduler simulation finished.")
    print(f"Are there pending tasks? {scheduler.has_pending_tasks}")
    print(f"Next task time: {scheduler.get_next_task_time()}")
