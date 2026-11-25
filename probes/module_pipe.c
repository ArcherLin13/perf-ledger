/* Wall time of one OpenCL process_cl at 1920x1080.
   A sample is the mean of repeated launches until at least 8 runs and 80 ms,
   matching the darktable export-window protocol. Three warmup windows are discarded.
   This times the module kernel and its argument setup, not the whole darktable process. */

#define CL_TARGET_OPENCL_VERSION 120
#include <CL/cl.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#endif

static int WIDTH = 1920;
static int HEIGHT = 1080;
#define SAMPLES 11
#define WARMUP 3

static void blocked(const char* reason) {
  printf("{\"perfbind\":1,\"blocked\":\"%s\",\"metrics\":[]}\n", reason);
  exit(2);
}

static void die(const char* what, cl_int err) {
  fprintf(stderr, "fail %s (%d)\n", what, (int)err);
  exit(1);
}

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
  return 0;
#endif
}

static char* read_file(const char* path) {
  FILE* file = fopen(path, "rb");
  if (!file) return NULL;
  fseek(file, 0, SEEK_END);
  long n = ftell(file);
  fseek(file, 0, SEEK_SET);
  char* buf = malloc((size_t)n + 1);
  if (fread(buf, 1, (size_t)n, file) != (size_t)n) {
    fclose(file);
    free(buf);
    return NULL;
  }
  buf[n] = 0;
  fclose(file);
  return buf;
}

static cl_device_id pick_device(void) {
  cl_uint nplat = 0;
  if (clGetPlatformIDs(0, NULL, &nplat) != CL_SUCCESS || nplat == 0) blocked("no_opencl_platform");
  cl_platform_id* plats = calloc(nplat, sizeof(cl_platform_id));
  clGetPlatformIDs(nplat, plats, NULL);
  cl_device_id chosen = NULL;
  for (cl_uint p = 0; p < nplat && !chosen; ++p) {
    cl_uint ndev = 0;
    if (clGetDeviceIDs(plats[p], CL_DEVICE_TYPE_GPU, 0, NULL, &ndev) != CL_SUCCESS || ndev == 0) continue;
    cl_device_id* devs = calloc(ndev, sizeof(cl_device_id));
    clGetDeviceIDs(plats[p], CL_DEVICE_TYPE_GPU, ndev, devs, NULL);
    chosen = devs[0];
    free(devs);
  }
  free(plats);
  if (!chosen) blocked("no_gpu_device");
  return chosen;
}

static cl_program build_program(cl_context ctx, cl_device_id dev, const char* source, const char* include_dir) {
  cl_int err = 0;
  size_t len = strlen(source);
  cl_program program = clCreateProgramWithSource(ctx, 1, &source, &len, &err);
  if (err != CL_SUCCESS) die("program", err);
  char options[512];
  snprintf(options, sizeof options, "-cl-std=CL1.2 -I %s", include_dir);
  err = clBuildProgram(program, 1, &dev, options, NULL, NULL);
  if (err != CL_SUCCESS) {
    size_t log_n = 0;
    clGetProgramBuildInfo(program, dev, CL_PROGRAM_BUILD_LOG, 0, NULL, &log_n);
    char* log = calloc(log_n + 1, 1);
    clGetProgramBuildInfo(program, dev, CL_PROGRAM_BUILD_LOG, log_n, log, NULL);
    fprintf(stderr, "%s\n", log);
    die("build", err);
  }
  return program;
}

typedef struct {
  float s_2, m_2, g, t_1, n_r, n;
} Ssts;

static Ssts ssts_init(double peak) {
  const double n_r = 100.0, g = 1.15, c = 0.18, c_d = 10.013, w_g = 0.14, t_1 = 0.04;
  const double r_hit_min = 128.0, r_hit_max = 896.0;
  const double n = fmax(peak, 1.0);
  const double r_hit = r_hit_min + (r_hit_max - r_hit_min) * (log(n / n_r) / log(100.0));
  const double m_0 = n / n_r;
  const double m_1 = 0.5 * (m_0 + sqrt(m_0 * (m_0 + 4.0 * t_1)));
  const double u = pow((r_hit / m_1) / ((r_hit / m_1) + 1.0), g);
  const double m = m_1 / u;
  const double w_i = log(n / 100.0) / log(2.0);
  const double c_t = (c_d / n_r) * (1.0 + w_i * w_g);
  const double g_ip = 0.5 * (c_t + sqrt(c_t * (c_t + 4.0 * t_1)));
  const double g_ipp2 = -(m_1 * pow(g_ip / m, 1.0 / g)) / (pow(g_ip / m, 1.0 / g) - 1.0);
  const double w_2 = c / g_ipp2;
  const double s_2 = w_2 * m_1;
  const double u_2 = pow((r_hit / m_1) / ((r_hit / m_1) + w_2), g);
  Ssts out = { (float)s_2, (float)(m_1 / u_2), (float)g, (float)t_1, (float)n_r, (float)n };
  (void)m;
  return out;
}

typedef struct {
  float input_matrix[9];
  float output_matrix[9];
  float luma_coeff[3];
  float color_look_mat[9];
  float exposure_factor;
  float contrast;
  float contrast_pivot;
  float hl_desat;
  float hl_rotation;
  float white_chroma_x;
  float white_chroma_z;
  float gray_point;
  float gray_gamma;
  float vibrance;
  float gamut_knee;
  float gamut_steepness;
  float ssts_s_2;
  float ssts_m_2;
  float ssts_g;
  float ssts_t_1;
  float ssts_n_r;
  float ssts_n;
  float look_opacity;
  int look_idx;
} SpectralParams;

#define GAMUT_N 362
typedef struct {
  float fwd_matrix[9];
  float inv_matrix[9];
  float exposure_factor;
  float forward_limit;
  float f_l_n;
  float a_w;
  float z;
  float cz;
  float inv_cz;
  float d_rgb[3];
  float a_w_j;
  float ssts_s_2;
  float ssts_m_2;
  float ssts_g;
  float ssts_t_1;
  float ssts_n_r;
  float ssts_n;
  float model_gamma_inv;
  float chroma_compress_scale;
  float cc_sat;
  float cc_sat_thr;
  float cc_compr;
  float limit_j_max;
  float mid_J;
  float focus_dist;
  float lower_hull_gamma_inv;
  float table_reach_m[GAMUT_N];
  float table_hues[GAMUT_N];
  float table_cusp_j[GAMUT_N];
  float table_cusp_m[GAMUT_N];
  float table_upper_hull_gamma[GAMUT_N];
  int hue_search_min;
  int hue_search_max;
  int sdr_clip_enable;
  float sdr_clip_softness;
} AcesParams;

static void identity9(float* m) {
  memset(m, 0, 9 * sizeof(float));
  m[0] = m[4] = m[8] = 1.f;
}

static SpectralParams spectral_defaults(void) {
  SpectralParams p;
  memset(&p, 0, sizeof p);
  identity9(p.input_matrix);
  identity9(p.output_matrix);
  identity9(p.color_look_mat);
  p.luma_coeff[0] = 0.2627f;
  p.luma_coeff[1] = 0.6780f;
  p.luma_coeff[2] = 0.0593f;
  const double brilliance = 5.0;
  p.exposure_factor = exp2f((float)(0.061 * brilliance));
  p.contrast = 2.25f;
  p.contrast_pivot = 0.5f;
  p.hl_desat = 0.50f;
  p.gray_gamma = 1.f;
  p.vibrance = 1.f;
  p.gamut_knee = 0.15f;
  p.gamut_steepness = 0.50f;
  p.look_opacity = 1.f;
  p.white_chroma_x = 1.f;
  p.white_chroma_z = 1.f;
  Ssts s = ssts_init(100.0 * pow(100.0, brilliance / 100.0));
  p.ssts_s_2 = s.s_2;
  p.ssts_m_2 = s.m_2;
  p.ssts_g = s.g;
  p.ssts_t_1 = s.t_1;
  p.ssts_n_r = s.n_r;
  p.ssts_n = s.n;
  return p;
}

static AcesParams aces_defaults(void) {
  AcesParams p;
  memset(&p, 0, sizeof p);
  identity9(p.fwd_matrix);
  identity9(p.inv_matrix);
  Ssts s = ssts_init(100.0);
  p.exposure_factor = 1.f;
  p.forward_limit = 1.f;
  p.f_l_n = 1.f;
  p.a_w = 1.f;
  p.z = 1.f;
  p.cz = 1.f;
  p.inv_cz = 1.f;
  p.d_rgb[0] = p.d_rgb[1] = p.d_rgb[2] = 1.f;
  p.a_w_j = 1.f;
  p.ssts_s_2 = s.s_2;
  p.ssts_m_2 = s.m_2;
  p.ssts_g = s.g;
  p.ssts_t_1 = s.t_1;
  p.ssts_n_r = s.n_r;
  p.ssts_n = s.n;
  p.model_gamma_inv = 1.f;
  p.chroma_compress_scale = 1.f;
  p.cc_sat = 1.f;
  p.cc_sat_thr = 0.5f;
  p.cc_compr = 1.f;
  p.limit_j_max = 1.f;
  p.mid_J = 0.5f;
  p.focus_dist = 1.f;
  p.lower_hull_gamma_inv = 1.f;
  for (int i = 0; i < GAMUT_N; ++i) {
    p.table_hues[i] = (float)(i - 1);
    p.table_reach_m[i] = 1.f;
    p.table_cusp_j[i] = 0.5f;
    p.table_cusp_m[i] = 1.f;
    p.table_upper_hull_gamma[i] = 1.f;
  }
  p.hue_search_min = 30;
  p.hue_search_max = 30;
  p.sdr_clip_enable = 0;
  p.sdr_clip_softness = 0.0152f;
  return p;
}

static cl_mem make_image(cl_context ctx, float* pixels, cl_mem_flags flags) {
  cl_image_format fmt = { CL_RGBA, CL_FLOAT };
  cl_image_desc desc;
  memset(&desc, 0, sizeof desc);
  desc.image_type = CL_MEM_OBJECT_IMAGE2D;
  desc.image_width = WIDTH;
  desc.image_height = HEIGHT;
  cl_int err = 0;
  cl_mem image = clCreateImage(ctx, flags | CL_MEM_COPY_HOST_PTR, &fmt, &desc, pixels, &err);
  if (err != CL_SUCCESS) die("image", err);
  return image;
}

static double finish_ms(cl_command_queue q, cl_kernel kernel, size_t* global) {
  cl_int err = clEnqueueNDRangeKernel(q, kernel, 2, NULL, global, NULL, 0, NULL, NULL);
  if (err != CL_SUCCESS) die("enqueue", err);
  double t0 = now_ms();
  err = clFinish(q);
  double ms = now_ms() - t0;
  if (err != CL_SUCCESS) die("finish", err);
  return ms;
}

static double window_mean(double (*once)(void*), void* ctx) {
  int n = 0;
  double sum = 0;
  while (n < 8 || sum < 80.0) {
    sum += once(ctx);
    n += 1;
    if (n >= 40) break;
  }
  return sum / (double)n;
}

typedef struct {
  cl_command_queue q;
  cl_kernel kernel;
  cl_mem in_img;
  cl_mem out_img;
  cl_mem in_buf;
  cl_mem out_buf;
  cl_mem params;
  SpectralParams spectral;
  size_t global[2];
  int kind;
} Job;

static double once_color(void* ctx) {
  Job* job = ctx;
  int width = WIDTH, height = HEIGHT, unbound = 1;
  float scale[4] = { 1.f, 1.f, 1.f, 1.f };
  float offset[4] = { 0.f, 0.f, 0.f, 0.f };
  clSetKernelArg(job->kernel, 0, sizeof(cl_mem), &job->in_img);
  clSetKernelArg(job->kernel, 1, sizeof(cl_mem), &job->out_img);
  clSetKernelArg(job->kernel, 2, sizeof(int), &width);
  clSetKernelArg(job->kernel, 3, sizeof(int), &height);
  clSetKernelArg(job->kernel, 4, sizeof(scale), scale);
  clSetKernelArg(job->kernel, 5, sizeof(offset), offset);
  clSetKernelArg(job->kernel, 6, sizeof(int), &unbound);
  return finish_ms(job->q, job->kernel, job->global);
}

static double once_spectral(void* ctx) {
  Job* job = ctx;
  int width = WIDTH, height = HEIGHT;
  clSetKernelArg(job->kernel, 0, sizeof(cl_mem), &job->in_img);
  clSetKernelArg(job->kernel, 1, sizeof(cl_mem), &job->out_img);
  clSetKernelArg(job->kernel, 2, sizeof(int), &width);
  clSetKernelArg(job->kernel, 3, sizeof(int), &height);
  clSetKernelArg(job->kernel, 4, sizeof(job->spectral), &job->spectral);
  return finish_ms(job->q, job->kernel, job->global);
}

static double once_exposure(void* ctx) {
  Job* job = ctx;
  int width = WIDTH, height = HEIGHT;
  float black = 0.f, scale = 1.f;
  clSetKernelArg(job->kernel, 0, sizeof(cl_mem), &job->in_img);
  clSetKernelArg(job->kernel, 1, sizeof(cl_mem), &job->out_img);
  clSetKernelArg(job->kernel, 2, sizeof(int), &width);
  clSetKernelArg(job->kernel, 3, sizeof(int), &height);
  clSetKernelArg(job->kernel, 4, sizeof(float), &black);
  clSetKernelArg(job->kernel, 5, sizeof(float), &scale);
  return finish_ms(job->q, job->kernel, job->global);
}

static double once_vibrance(void* ctx) {
  Job* job = ctx;
  int width = WIDTH, height = HEIGHT;
  float amount = 0.25f;
  clSetKernelArg(job->kernel, 0, sizeof(cl_mem), &job->in_img);
  clSetKernelArg(job->kernel, 1, sizeof(cl_mem), &job->out_img);
  clSetKernelArg(job->kernel, 2, sizeof(int), &width);
  clSetKernelArg(job->kernel, 3, sizeof(int), &height);
  clSetKernelArg(job->kernel, 4, sizeof(float), &amount);
  return finish_ms(job->q, job->kernel, job->global);
}

static double once_split(void* ctx) {
  Job* job = ctx;
  int width = WIDTH, height = HEIGHT;
  float compress = 0.2f, balance = 0.5f, shadow_hue = 0.1f, shadow_sat = 0.5f, hi_hue = 0.6f, hi_sat = 0.5f;
  clSetKernelArg(job->kernel, 0, sizeof(cl_mem), &job->in_img);
  clSetKernelArg(job->kernel, 1, sizeof(cl_mem), &job->out_img);
  clSetKernelArg(job->kernel, 2, sizeof(int), &width);
  clSetKernelArg(job->kernel, 3, sizeof(int), &height);
  clSetKernelArg(job->kernel, 4, sizeof(float), &compress);
  clSetKernelArg(job->kernel, 5, sizeof(float), &balance);
  clSetKernelArg(job->kernel, 6, sizeof(float), &shadow_hue);
  clSetKernelArg(job->kernel, 7, sizeof(float), &shadow_sat);
  clSetKernelArg(job->kernel, 8, sizeof(float), &hi_hue);
  clSetKernelArg(job->kernel, 9, sizeof(float), &hi_sat);
  return finish_ms(job->q, job->kernel, job->global);
}

static double once_aces(void* ctx) {
  Job* job = ctx;
  int width = WIDTH, height = HEIGHT;
  clSetKernelArg(job->kernel, 0, sizeof(cl_mem), &job->in_buf);
  clSetKernelArg(job->kernel, 1, sizeof(cl_mem), &job->out_buf);
  clSetKernelArg(job->kernel, 2, sizeof(int), &width);
  clSetKernelArg(job->kernel, 3, sizeof(int), &height);
  clSetKernelArg(job->kernel, 4, sizeof(cl_mem), &job->params);
  return finish_ms(job->q, job->kernel, job->global);
}

static void emit(const char* id, const char* colorspace, int kernels, double* samples) {
  printf("{\"id\":\"%s_%dx%d\",\"module\":\"%s\",\"colorspace\":\"%s\",\"kernels\":%d,\"halo\":0,\"width\":%d,\"height\":%d,\"unit\":\"ms\",\"samples\":[",
         id, WIDTH, HEIGHT, id, colorspace, kernels, WIDTH, HEIGHT);
  for (int i = 0; i < SAMPLES; ++i) printf("%s%.6f", i ? "," : "", samples[i]);
  printf("]}\n");
}

int main(int argc, char** argv) {
  if (argc < 3) blocked("usage");
  const char* name = argv[1];
  const char* include_dir = argv[2];
  if (argc >= 5) {
    WIDTH = atoi(argv[3]);
    HEIGHT = atoi(argv[4]);
    if (WIDTH <= 0 || HEIGHT <= 0) blocked("bad size");
  }
#ifdef _WIN32
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
#endif
  cl_device_id dev = pick_device();
  cl_int err = 0;
  cl_context ctx = clCreateContext(NULL, 1, &dev, NULL, NULL, &err);
  if (err != CL_SUCCESS) die("context", err);
  cl_command_queue q = clCreateCommandQueue(ctx, dev, 0, &err);
  if (err != CL_SUCCESS) die("queue", err);

  size_t pixels = (size_t)WIDTH * HEIGHT * 4;
  float* host = calloc(pixels, sizeof(float));
  for (size_t i = 0; i < pixels; i += 4) {
    host[i] = (float)((i / 4) % WIDTH) / (float)WIDTH;
    host[i + 1] = (float)((i / 4) / WIDTH) / (float)HEIGHT;
    host[i + 2] = 0.18f;
    host[i + 3] = 1.f;
  }

  Job job;
  memset(&job, 0, sizeof job);
  job.q = q;
  job.global[0] = WIDTH;
  job.global[1] = HEIGHT;
  const char* kernel_name = NULL;
  double (*once)(void*) = NULL;
  const char* colorspace = NULL;

  if (strcmp(name, "colorcontrast") == 0) {
    const char* source =
        "#include \"common.h\"\n"
        "__kernel void colorcontrast(read_only image2d_t in, write_only image2d_t out, const int width, const int height,\n"
        "               const float4 scale, const float4 offset, const int unbound) {\n"
        "  const int x = get_global_id(0);\n"
        "  const int y = get_global_id(1);\n"
        "  if (x >= width || y >= height) return;\n"
        "  float4 pixel = read_imagef(in, sampleri, (int2)(x, y));\n"
        "  pixel.xyz = (pixel * scale + offset).xyz;\n"
        "  pixel.y = unbound ? pixel.y : clamp(pixel.y, -128.0f, 128.0f);\n"
        "  pixel.z = unbound ? pixel.z : clamp(pixel.z, -128.0f, 128.0f);\n"
        "  write_imagef(out, (int2)(x, y), pixel);\n"
        "}\n";
    cl_program program = build_program(ctx, dev, source, include_dir);
    job.kernel = clCreateKernel(program, "colorcontrast", &err);
    if (err != CL_SUCCESS) die("kernel", err);
    job.in_img = make_image(ctx, host, CL_MEM_READ_ONLY);
    job.out_img = make_image(ctx, host, CL_MEM_WRITE_ONLY);
    once = once_color;
    colorspace = "lab";
    kernel_name = "colorcontrast";
  } else if (strcmp(name, "spectral_tone") == 0) {
    char path[512];
    snprintf(path, sizeof path, "%s/spectral_tone.cl", include_dir);
    char* source = read_file(path);
    if (!source) blocked("spectral_tone.cl");
    cl_program program = build_program(ctx, dev, source, include_dir);
    free(source);
    job.kernel = clCreateKernel(program, "spectral_tone", &err);
    if (err != CL_SUCCESS) die("kernel", err);
    job.in_img = make_image(ctx, host, CL_MEM_READ_ONLY);
    job.out_img = make_image(ctx, host, CL_MEM_WRITE_ONLY);
    job.spectral = spectral_defaults();
    once = once_spectral;
    colorspace = "rgb";
    kernel_name = "spectral_tone";
  } else if (strcmp(name, "aces20") == 0) {
    char path[512];
    snprintf(path, sizeof path, "%s/aces20.cl", include_dir);
    char* source = read_file(path);
    if (!source) blocked("aces20.cl");
    cl_program program = build_program(ctx, dev, source, include_dir);
    free(source);
    job.kernel = clCreateKernel(program, "kernel_aces20", &err);
    if (err != CL_SUCCESS) die("kernel", err);
    job.in_buf = clCreateBuffer(ctx, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, pixels * sizeof(float), host, &err);
    if (err != CL_SUCCESS) die("buffer", err);
    job.out_buf = clCreateBuffer(ctx, CL_MEM_WRITE_ONLY, pixels * sizeof(float), NULL, &err);
    if (err != CL_SUCCESS) die("buffer", err);
    AcesParams params = aces_defaults();
    job.params = clCreateBuffer(ctx, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, sizeof params, &params, &err);
    if (err != CL_SUCCESS) die("params", err);
    once = once_aces;
    colorspace = "rgb";
    kernel_name = "aces20";
  } else if (strcmp(name, "exposure") == 0 || strcmp(name, "vibrance") == 0 || strcmp(name, "splittoning") == 0) {
    const char* source = NULL;
    if (strcmp(name, "exposure") == 0) {
      source =
          "#include \"common.h\"\n"
          "kernel void exposure(read_only image2d_t in, write_only image2d_t out, const int width, const int height, const float black, const float scale) {\n"
          "  const int x = get_global_id(0);\n"
          "  const int y = get_global_id(1);\n"
          "  if (x >= width || y >= height) return;\n"
          "  float4 pixel = readpixel(in, x, y);\n"
          "  pixel.xyz = ((pixel - black) * scale).xyz;\n"
          "  write_imagef(out, (int2)(x, y), pixel);\n"
          "}\n";
      kernel_name = "exposure";
    } else if (strcmp(name, "vibrance") == 0) {
      source =
          "#include \"common.h\"\n"
          "__kernel void vibrance(read_only image2d_t in, write_only image2d_t out, const int width, const int height, const float amount) {\n"
          "  const int x = get_global_id(0);\n"
          "  const int y = get_global_id(1);\n"
          "  if (x >= width || y >= height) return;\n"
          "  float4 pixel = readpixel(in, x, y);\n"
          "  const float sw = dt_fast_hypot(pixel.y, pixel.z) / 256.0f;\n"
          "  const float ls = 1.0f - amount * sw * 0.25f;\n"
          "  const float ss = 1.0f + amount * sw;\n"
          "  pixel.x *= ls; pixel.y *= ss; pixel.z *= ss;\n"
          "  write_imagef(out, (int2)(x, y), pixel);\n"
          "}\n";
      kernel_name = "vibrance";
    } else {
      source =
          "#include \"common.h\"\n"
          "#include \"colorspace.h\"\n"
          "kernel void splittoning(read_only image2d_t in, write_only image2d_t out, const int width, const int height,\n"
          "  const float compress, const float balance, const float shadow_hue, const float shadow_saturation,\n"
          "  const float highlight_hue, const float highlight_saturation) {\n"
          "  const int x = get_global_id(0);\n"
          "  const int y = get_global_id(1);\n"
          "  if (x >= width || y >= height) return;\n"
          "  float4 pixel = read_imagef(in, sampleri, (int2)(x, y));\n"
          "  float4 hsl = RGB_2_HSL(pixel);\n"
          "  if (hsl.z < balance - compress || hsl.z > balance + compress) {\n"
          "    hsl.x = hsl.z < balance ? shadow_hue : highlight_hue;\n"
          "    hsl.y = hsl.z < balance ? shadow_saturation : highlight_saturation;\n"
          "    const float ra = hsl.z < balance ? clipf(2.0f * fabs(-balance + compress + hsl.z)) : clipf(2.0f * fabs(-balance - compress + hsl.z));\n"
          "    float4 mixrgb = HSL_2_RGB(hsl);\n"
          "    pixel.xyz = clamp(pixel * (1.0f - ra) + mixrgb * ra, (float4)0.0f, (float4)1.0f).xyz;\n"
          "  }\n"
          "  write_imagef(out, (int2)(x, y), pixel);\n"
          "}\n";
      kernel_name = "splittoning";
    }
    cl_program program = build_program(ctx, dev, source, include_dir);
    job.kernel = clCreateKernel(program, kernel_name, &err);
    if (err != CL_SUCCESS) die("kernel", err);
    job.in_img = make_image(ctx, host, CL_MEM_READ_ONLY);
    job.out_img = make_image(ctx, host, CL_MEM_WRITE_ONLY);
    once = strcmp(name, "exposure") == 0 ? once_exposure : strcmp(name, "vibrance") == 0 ? once_vibrance : once_split;
    colorspace = strcmp(name, "vibrance") == 0 ? "lab" : "rgb";
  } else {
    blocked("unknown_module");
  }

  double samples[SAMPLES];
  for (int i = 0; i < WARMUP; ++i) window_mean(once, &job);
  for (int i = 0; i < SAMPLES; ++i) {
    samples[i] = window_mean(once, &job);
    fprintf(stderr, "%s sample %d %.4f\n", kernel_name, i + 1, samples[i]);
  }
  emit(kernel_name, colorspace, 1, samples);
  free(host);
  return 0;
}
