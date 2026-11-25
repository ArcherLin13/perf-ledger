/* Ascend device-memory copy. Host-to-device copies are not device DRAM.
   Samples are 150 ms windows of aclrtMemcpy device-to-device, timed with events.
   If the runtime cannot open a device, this prints blocked and no rate. */

#include <stdio.h>
#include <stdlib.h>

#ifdef _WIN32
#include <windows.h>
#endif

#define SAMPLES 11
#define WARMUP 3
#define TARGET_MS 150.0f

#include "acl/acl.h"

static void blocked(const char* reason) {
  printf("{\"perfbind\":1,\"backend\":\"ascend_npu\",\"blocked\":\"%s\",\"metrics\":[]}\n", reason);
  exit(2);
}

static void check(aclError err, const char* what) {
  if (err != ACL_SUCCESS) {
    fprintf(stderr, "fail %s (%d)\n", what, (int)err);
    blocked("runtime_failed");
  }
}

static float elapsed_ms(aclrtEvent start, aclrtEvent end) {
  float ms = 0.f;
  check(aclrtSynchronizeEvent(end), "sync");
  check(aclrtEventElapsedTime(&ms, start, end), "elapsed");
  return ms;
}

static double window_gbps(void* dst, void* src, size_t bytes, aclrtEvent start, aclrtEvent end, aclrtStream stream) {
  check(aclrtRecordEvent(start, stream), "record");
  check(aclrtMemcpyAsync(dst, bytes, src, bytes, ACL_MEMCPY_DEVICE_TO_DEVICE, stream), "d2d");
  check(aclrtRecordEvent(end, stream), "record");
  float one = elapsed_ms(start, end);
  int passes = (int)(TARGET_MS / one + 0.5f);
  if (passes < 1) passes = 1;
  if (passes > 20000) passes = 20000;
  check(aclrtRecordEvent(start, stream), "record");
  for (int i = 0; i < passes; ++i) {
    check(aclrtMemcpyAsync(dst, bytes, src, bytes, ACL_MEMCPY_DEVICE_TO_DEVICE, stream), "d2d");
  }
  check(aclrtRecordEvent(end, stream), "record");
  float ms = elapsed_ms(start, end);
  return ((double)bytes * 2.0 * (double)passes) / ((double)ms * 1e6);
}

int main(void) {
#ifdef _WIN32
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
#endif
  if (aclInit(NULL) != ACL_SUCCESS) blocked("acl_init_failed");
  if (aclrtSetDevice(0) != ACL_SUCCESS) blocked("no_device");
  const size_t sizes[] = {8ull * 1024 * 1024, 128ull * 1024 * 1024};
  const char* labels[] = {"8192KiB", "131072KiB"};
  void* a = NULL;
  void* b = NULL;
  check(aclrtMalloc(&a, sizes[1], ACL_MEM_MALLOC_HUGE_FIRST), "malloc");
  check(aclrtMalloc(&b, sizes[1], ACL_MEM_MALLOC_HUGE_FIRST), "malloc");
  aclrtEvent start, end;
  aclrtStream stream = NULL;
  check(aclrtCreateStream(&stream), "stream");
  check(aclrtCreateEvent(&start), "event");
  check(aclrtCreateEvent(&end), "event");
  printf("{\n  \"perfbind\": 1,\n  \"backend\": \"ascend_npu\",\n  \"probe_set\": \"ascend_d2d_copy\",\n  \"metrics\": [\n");
  for (int s = 0; s < 2; ++s) {
    char id[64];
    snprintf(id, sizeof id, "d2d_copy_%s", labels[s]);
    fprintf(stderr, "probe %s\n", id);
    for (int w = 0; w < WARMUP; ++w) window_gbps(b, a, sizes[s], start, end, stream);
    if (s) printf(",\n");
    printf("    {\"id\": \"%s\", \"kind\": \"copy\", \"unit\": \"GB/s\", \"bytes\": %zu, \"samples\": [", id, sizes[s]);
    for (int i = 0; i < SAMPLES; ++i) {
      double gbps = window_gbps(b, a, sizes[s], start, end, stream);
      printf("%s%.6f", i ? ", " : "", gbps);
    }
    printf("]}");
  }
  printf("\n  ]\n}\n");
  aclrtFree(a);
  aclrtFree(b);
  aclFinalize();
  return 0;
}
