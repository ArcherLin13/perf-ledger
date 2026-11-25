/* One thread, core 0. Sequential read, write, and copy.
   Iterations are chosen so one sample is about 150 ms of a tight loop.
   The clock is outside that loop. Three warmup samples are discarded.
   Copy counts bytes read plus bytes written. */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <time.h>
#endif

#define SAMPLES 11
#define WARMUP 3

static volatile uint64_t g_sink;

static double now_ms(void) {
#ifdef _WIN32
  static LARGE_INTEGER freq;
  static int ready = 0;
  LARGE_INTEGER counter;
  if (!ready) {
    QueryPerformanceFrequency(&freq);
    ready = 1;
  }
  QueryPerformanceCounter(&counter);
  return (double)counter.QuadPart * 1000.0 / (double)freq.QuadPart;
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

static void pin_main_thread(void) {
#ifdef _WIN32
  SetThreadAffinityMask(GetCurrentThread(), 1);
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
#endif
}

static uint64_t seq_read(uint64_t* buf, size_t count, int iters) {
  uint64_t acc = 0;
  for (int r = 0; r < iters; ++r) {
    for (size_t i = 0; i < count; ++i) acc += buf[i];
    __asm__ __volatile__("" : "+r"(acc)::"memory");
  }
  g_sink = acc;
  return acc;
}

static uint64_t seq_write(uint64_t* buf, size_t count, int iters) {
  uint64_t acc = 0;
  for (int r = 0; r < iters; ++r) {
    for (size_t i = 0; i < count; ++i) buf[i] = i + (uint64_t)r;
    acc += buf[0];
    __asm__ __volatile__("" : "+r"(acc)::"memory");
  }
  g_sink = acc;
  return acc;
}

static uint64_t seq_copy(uint64_t* dst, uint64_t* src, size_t count, int iters) {
  uint64_t acc = 0;
  for (int r = 0; r < iters; ++r) {
    for (size_t i = 0; i < count; ++i) dst[i] = src[i];
    acc += dst[0];
    __asm__ __volatile__("" : "+r"(acc)::"memory");
  }
  g_sink = acc;
  return acc;
}

static int calibrate_read(uint64_t* buf, size_t count) {
  int iters = 1;
  for (int attempt = 0; attempt < 24; ++attempt) {
    double t0 = now_ms();
    seq_read(buf, count, iters);
    double ms = now_ms() - t0;
    if (ms >= 80.0) {
      int scaled = (int)(iters * (150.0 / ms));
      if (scaled < 1) scaled = 1;
      return scaled;
    }
    iters = ms < 1.0 ? iters * 4 : (int)(iters * (100.0 / ms)) + 1;
    if (iters > 2000000) return 2000000;
  }
  return iters;
}

static int calibrate_write(uint64_t* buf, size_t count) {
  int iters = 1;
  for (int attempt = 0; attempt < 24; ++attempt) {
    double t0 = now_ms();
    seq_write(buf, count, iters);
    double ms = now_ms() - t0;
    if (ms >= 80.0) {
      int scaled = (int)(iters * (150.0 / ms));
      if (scaled < 1) scaled = 1;
      return scaled;
    }
    iters = ms < 1.0 ? iters * 4 : (int)(iters * (100.0 / ms)) + 1;
    if (iters > 2000000) return 2000000;
  }
  return iters;
}

static int calibrate_copy(uint64_t* dst, uint64_t* src, size_t count) {
  int iters = 1;
  for (int attempt = 0; attempt < 24; ++attempt) {
    double t0 = now_ms();
    seq_copy(dst, src, count, iters);
    double ms = now_ms() - t0;
    if (ms >= 80.0) {
      int scaled = (int)(iters * (150.0 / ms));
      if (scaled < 1) scaled = 1;
      return scaled;
    }
    iters = ms < 1.0 ? iters * 4 : (int)(iters * (100.0 / ms)) + 1;
    if (iters > 2000000) return 2000000;
  }
  return iters;
}

static double sample_gbps(double bytes, double ms) {
  return bytes / (ms * 1e6);
}

static void emit(const char* id, const char* kind, size_t bytes, double* values, int* first) {
  if (!*first) printf(",\n");
  *first = 0;
  printf("    {\"id\": \"%s\", \"kind\": \"%s\", \"unit\": \"GB/s\", \"bytes\": %zu, \"samples\": [", id, kind, bytes);
  for (int i = 0; i < SAMPLES; ++i) printf("%s%.6f", i ? ", " : "", values[i]);
  printf("]}");
}

int main(void) {
  pin_main_thread();
  const size_t sizes[] = {32ull * 1024, 8ull * 1024 * 1024, 32ull * 1024 * 1024, 128ull * 1024 * 1024};
  const char* labels[] = {"32KiB", "8192KiB", "32768KiB", "131072KiB"};
  size_t big = sizes[3];
  uint64_t* buf = 0;
  uint64_t* buf2 = 0;
#ifdef _WIN32
  buf = _aligned_malloc(big, 64);
  buf2 = _aligned_malloc(big, 64);
#else
  buf = aligned_alloc(64, big);
  buf2 = aligned_alloc(64, big);
#endif
  if (!buf || !buf2) {
    fprintf(stderr, "alloc failed\n");
    return 1;
  }
  for (size_t i = 0; i < big / sizeof(uint64_t); ++i) buf[i] = 1;
  printf("{\n  \"perfbind\": 1,\n  \"backend\": \"cpu\",\n  \"probe_set\": \"cpu_sequential\",\n  \"metrics\": [\n");
  int first = 1;
  for (int s = 0; s < 4; ++s) {
    size_t count = sizes[s] / sizeof(uint64_t);
    char id[64];
    double values[SAMPLES];
    int iters = calibrate_read(buf, count);
    fprintf(stderr, "probe read_%s iters %d\n", labels[s], iters);
    for (int w = 0; w < WARMUP; ++w) seq_read(buf, count, iters);
    for (int i = 0; i < SAMPLES; ++i) {
      double t0 = now_ms();
      seq_read(buf, count, iters);
      values[i] = sample_gbps((double)sizes[s] * (double)iters, now_ms() - t0);
    }
    snprintf(id, sizeof id, "read_%s", labels[s]);
    emit(id, "read", sizes[s], values, &first);

    iters = calibrate_write(buf, count);
    fprintf(stderr, "probe write_%s iters %d\n", labels[s], iters);
    for (int w = 0; w < WARMUP; ++w) seq_write(buf, count, iters);
    for (int i = 0; i < SAMPLES; ++i) {
      double t0 = now_ms();
      seq_write(buf, count, iters);
      values[i] = sample_gbps((double)sizes[s] * (double)iters, now_ms() - t0);
    }
    snprintf(id, sizeof id, "write_%s", labels[s]);
    emit(id, "write", sizes[s], values, &first);

    iters = calibrate_copy(buf2, buf, count);
    fprintf(stderr, "probe copy_%s iters %d\n", labels[s], iters);
    for (int w = 0; w < WARMUP; ++w) seq_copy(buf2, buf, count, iters);
    for (int i = 0; i < SAMPLES; ++i) {
      double t0 = now_ms();
      seq_copy(buf2, buf, count, iters);
      values[i] = sample_gbps((double)sizes[s] * 2.0 * (double)iters, now_ms() - t0);
    }
    snprintf(id, sizeof id, "copy_%s", labels[s]);
    emit(id, "copy", sizes[s], values, &first);
  }
  printf("\n  ]\n}\n");
  fprintf(stderr, "sink %llu\n", (unsigned long long)g_sink);
#ifdef _WIN32
  _aligned_free(buf);
  _aligned_free(buf2);
#else
  free(buf);
  free(buf2);
#endif
  return 0;
}
